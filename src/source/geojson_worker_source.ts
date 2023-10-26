import {getJSON} from '../util/ajax';

import {RequestPerformance} from '../util/performance';
import rewind from '@mapbox/geojson-rewind';
import {GeoJSONWrapper} from './geojson_wrapper';
import vtpbf from 'vt-pbf';
import Supercluster, {type Options as SuperclusterOptions, type ClusterProperties} from 'supercluster';
import geojsonvt, {type Options as GeoJSONVTOptions} from 'geojson-vt';
import {VectorTileWorkerSource} from './vector_tile_worker_source';
import {createExpression, type Feature} from '@maplibre/maplibre-gl-style-spec';

import type {
    WorkerTileParameters,
    WorkerTileResult,
} from '../source/worker_source';

import type {IActor} from '../util/actor';
import type {StyleLayerIndex} from '../style/style_layer_index';

import type {LoadVectorData, LoadVectorDataCallback, LoadVectorTileResult} from './vector_tile_worker_source';
import type {RequestParameters, ResponseCallback} from '../util/ajax';
import type {Cancelable} from '../types/cancelable';
import {isUpdateableGeoJSON, type GeoJSONSourceDiff, applySourceDiff, toUpdateable, GeoJSONFeatureId} from './geojson_source_diff';
import type {ClusterIDAndSource, GeoJSONWorkerSourceLoadDataResult, RemoveSourceParams} from '../util/actor_messages';

export type GeoJSONWorkerOptions = {
    source?: string;
    cluster?: boolean;
    geojsonVtOptions?: GeoJSONVTOptions;
    superclusterOptions?: SuperclusterOptions<any, any>;
    clusterProperties?: ClusterProperties;
    filter?: Array<unknown>;
    promoteId?: string;
    collectResourceTiming?: boolean;
}

export type LoadGeoJSONParameters = GeoJSONWorkerOptions & {
    type: 'geojson';
    request?: RequestParameters;
    /**
     * Literal GeoJSON data. Must be provided if `request.url` is not.
     */
    data?: string;
    dataDiff?: GeoJSONSourceDiff;
};

export type LoadGeoJSON = (params: LoadGeoJSONParameters, abortController: AbortController) => Promise<GeoJSON.GeoJSON>;

type GeoJSONIndex = ReturnType<typeof geojsonvt> | Supercluster;

/**
 * The {@link WorkerSource} implementation that supports {@link GeoJSONSource}.
 * This class is designed to be easily reused to support custom source types
 * for data formats that can be parsed/converted into an in-memory GeoJSON
 * representation. To do so, create it with
 * `new GeoJSONWorkerSource(actor, layerIndex, customLoadGeoJSONFunction)`.
 * For a full example, see [mapbox-gl-topojson](https://github.com/developmentseed/mapbox-gl-topojson).
 */
export class GeoJSONWorkerSource extends VectorTileWorkerSource {
    _pendingPromise: (value: GeoJSONWorkerSourceLoadDataResult) => void;
    _pendingRequest: AbortController;
    _geoJSONIndex: GeoJSONIndex;
    _dataUpdateable = new Map<GeoJSONFeatureId, GeoJSON.Feature>();

    /**
     * @param loadGeoJSON - Optional method for custom loading/parsing of
     * GeoJSON based on parameters passed from the main-thread Source.
     * See {@link GeoJSONWorkerSource#loadGeoJSON}.
     */
    constructor(actor: IActor, layerIndex: StyleLayerIndex, availableImages: Array<string>, loadGeoJSON?: LoadGeoJSON | null) {
        super(actor, layerIndex, availableImages);
        this.loadVectorData = this.loadGeoJSONTile;
        if (loadGeoJSON) {
            this.loadGeoJSON = loadGeoJSON;
        }
    }

    async loadGeoJSONTile(params: WorkerTileParameters, abortController: AbortController): Promise<LoadVectorTileResult> {
        const canonical = params.tileID.canonical;

        if (!this._geoJSONIndex) {
            return;
        }

        const geoJSONTile = this._geoJSONIndex.getTile(canonical.z, canonical.x, canonical.y);
        if (!geoJSONTile) {
            return;
        }

        const geojsonWrapper = new GeoJSONWrapper(geoJSONTile.features);
        // Encode the geojson-vt tile into binary vector tile form.  This
        // is a convenience that allows `FeatureIndex` to operate the same way
        // across `VectorTileSource` and `GeoJSONSource` data.
        let pbf = vtpbf(geojsonWrapper);
        if (pbf.byteOffset !== 0 || pbf.byteLength !== pbf.buffer.byteLength) {
            // Compatibility with node Buffer (https://github.com/mapbox/pbf/issues/35)
            pbf = new Uint8Array(pbf);
        }

        return {
            vectorTile: geojsonWrapper,
            rawData: pbf.buffer
        };
    }

    /**
     * Fetches (if appropriate), parses, and index geojson data into tiles. This
     * preparatory method must be called before {@link GeoJSONWorkerSource#loadTile}
     * can correctly serve up tiles.
     *
     * Defers to {@link GeoJSONWorkerSource#loadGeoJSON} for the fetching/parsing,
     * expecting `callback(error, data)` to be called with either an error or a
     * parsed GeoJSON object.
     *
     * When a `loadData` request comes in while a previous one is being processed,
     * the previous one is aborted.
     *
     * @param params - the parameters
     * @param callback - the callback for completion or error
     */
    loadData(params: LoadGeoJSONParameters): Promise<GeoJSONWorkerSourceLoadDataResult> {
        this._pendingRequest?.abort();
        if (this._pendingPromise) {
            // Tell the foreground the previous call has been abandoned
            this._pendingPromise({abandoned: true});
        }
        return new Promise<GeoJSONWorkerSourceLoadDataResult>((resolve, reject) => {
            const perf = (params && params.request && params.request.collectResourceTiming) ?
                new RequestPerformance(params.request) : false;

            this._pendingPromise = resolve;
            this._pendingRequest = new AbortController();
            this.loadGeoJSON(params, this._pendingRequest).then((data) => {
                delete this._pendingPromise;
                delete this._pendingRequest;

                if (!data) {
                    reject(new Error('No data was returned'));
                    return;
                }
                if (typeof data !== 'object') {
                    reject(new Error(`Input data given to '${params.source}' is not a valid GeoJSON object.`));
                    return;
                }
                rewind(data, true);

                try {
                    if (params.filter) {
                        const compiled = createExpression(params.filter, {type: 'boolean', 'property-type': 'data-driven', overridable: false, transition: false} as any);
                        if (compiled.result === 'error')
                            throw new Error(compiled.value.map(err => `${err.key}: ${err.message}`).join(', '));

                        const features = (data as GeoJSON.FeatureCollection).features.filter(feature => compiled.value.evaluate({zoom: 0}, feature as any));
                        data = {type: 'FeatureCollection', features};
                    }

                    this._geoJSONIndex = params.cluster ?
                        new Supercluster(getSuperclusterOptions(params)).load((data as any).features) :
                        geojsonvt(data, params.geojsonVtOptions);
                } catch (err) {
                    reject(err);
                    return;
                }

                this.loaded = {};

                const result = {} as { resourceTiming: {[_: string]: Array<PerformanceResourceTiming>} };
                if (perf) {
                    const resourceTimingData = perf.finish();
                    // it's necessary to eval the result of getEntriesByName() here via parse/stringify
                    // late evaluation in the main thread causes TypeError: illegal invocation
                    if (resourceTimingData) {
                        result.resourceTiming = {};
                        result.resourceTiming[params.source] = JSON.parse(JSON.stringify(resourceTimingData));
                    }
                }
                resolve(result);
            }).catch((err) => { reject(err); });
        });
    }

    /**
    * Implements {@link WorkerSource#reloadTile}.
    *
    * If the tile is loaded, uses the implementation in VectorTileWorkerSource.
    * Otherwise, such as after a setData() call, we load the tile fresh.
    *
    * @param params - the parameters
    * @param callback - the callback for completion or error
    */
    reloadTile(params: WorkerTileParameters): Promise<WorkerTileResult> {
        const loaded = this.loaded,
            uid = params.uid;

        if (loaded && loaded[uid]) {
            return super.reloadTile(params);
        } else {
            return this.loadTile(params);
        }
    }

    /**
     * Fetch and parse GeoJSON according to the given params.  Calls `callback`
     * with `(err, data)`, where `data` is a parsed GeoJSON object.
     *
     * GeoJSON is loaded and parsed from `params.url` if it exists, or else
     * expected as a literal (string or object) `params.data`.
     *
     * @param params - the parameters
     * @returns A promise.
     */
    loadGeoJSON = async (params: LoadGeoJSONParameters, abortController: AbortController): Promise<GeoJSON.GeoJSON> => {
        const {promoteId} = params;
        // Because of same origin issues, urls must either include an explicit
        // origin or absolute path.
        // ie: /foo/bar.json or http://example.com/bar.json
        // but not ../foo/bar.json
        if (params.request) {
            const data = await getJSON<GeoJSON.FeatureCollection>(params.request, abortController);
            this._dataUpdateable = isUpdateableGeoJSON(data, promoteId) ? toUpdateable(data, promoteId) : undefined;
            return data;
        }
        if (typeof params.data === 'string') {
            try {
                const parsed = JSON.parse(params.data) as GeoJSON.FeatureCollection;
                this._dataUpdateable = isUpdateableGeoJSON(parsed, promoteId) ? toUpdateable(parsed, promoteId) : undefined;
                return parsed;
            } catch (e) {
                throw new Error(`Input data given to '${params.source}' is not a valid GeoJSON object.`);
            }
        }
        if (params.dataDiff) {
            if (this._dataUpdateable) {
                applySourceDiff(this._dataUpdateable, params.dataDiff, promoteId);
                return {type: 'FeatureCollection', features: Array.from(this._dataUpdateable.values())};
            }
            throw new Error(`Cannot update existing geojson data in ${params.source}`);
        } 
        throw new Error(`Input data given to '${params.source}' is not a valid GeoJSON object.`);
    };

    async removeSource(_params: RemoveSourceParams): Promise<void> {
        if (this._pendingPromise) {
            // Don't leak callbacks
            this._pendingPromise({abandoned: true});
        }
    }

    getClusterExpansionZoom(params: ClusterIDAndSource): number {
        return (this._geoJSONIndex as Supercluster).getClusterExpansionZoom(params.clusterId);
    }

    getClusterChildren(params: ClusterIDAndSource): Array<GeoJSON.Feature> {
        return (this._geoJSONIndex as Supercluster).getChildren(params.clusterId);
    }

    getClusterLeaves(params: {
        clusterId: number;
        limit: number;
        offset: number;
    }): Array<GeoJSON.Feature> {
        return (this._geoJSONIndex as Supercluster).getLeaves(params.clusterId, params.limit, params.offset);
    }
}

function getSuperclusterOptions({superclusterOptions, clusterProperties}: LoadGeoJSONParameters) {
    if (!clusterProperties || !superclusterOptions) return superclusterOptions;

    const mapExpressions = {};
    const reduceExpressions = {};
    const globals = {accumulated: null, zoom: 0};
    const feature = {properties: null};
    const propertyNames = Object.keys(clusterProperties);

    for (const key of propertyNames) {
        const [operator, mapExpression] = clusterProperties[key];

        const mapExpressionParsed = createExpression(mapExpression);
        const reduceExpressionParsed = createExpression(
            typeof operator === 'string' ? [operator, ['accumulated'], ['get', key]] : operator);

        mapExpressions[key] = mapExpressionParsed.value;
        reduceExpressions[key] = reduceExpressionParsed.value;
    }

    superclusterOptions.map = (pointProperties) => {
        feature.properties = pointProperties;
        const properties = {};
        for (const key of propertyNames) {
            properties[key] = mapExpressions[key].evaluate(globals, feature);
        }
        return properties;
    };
    superclusterOptions.reduce = (accumulated, clusterProperties) => {
        feature.properties = clusterProperties;
        for (const key of propertyNames) {
            globals.accumulated = accumulated[key];
            accumulated[key] = reduceExpressions[key].evaluate(globals, feature);
        }
    };

    return superclusterOptions;
}
