import Apify, { Dataset, KeyValueStore } from 'apify';
import cheerio from 'cheerio';
import axios from 'axios';

import GlobalStore from './globalStore';

import { Schema, ProxySchema, State } from './types';
import { LABELS, REQUESTS, prepareRequestList } from './consts';
import { getProxiesFromTable, addProxiesToStore, testProxy, proxyLog, getProxiesFromSneakyTable, isValidURL } from './utils';

const { log } = Apify.utils;

Apify.main(async () => {
    const Store = new GlobalStore();
    await Store.initialize();

    const {
        testProxies = true,
        testTimeout = 15,
        testTarget = `https://google.com`,
        datasetName,
        kvStoreName = 'free-proxy-store',
        pushToKvStore = false,
    } = (await Apify.getInput()) as Schema;

    let kvStore: KeyValueStore | null = null;
    if (pushToKvStore) {
        kvStore = await Apify.openKeyValueStore(kvStoreName);
    }

    let namedDataset: Dataset | null = null;
    if (datasetName) {
        namedDataset = await Apify.openDataset(datasetName);
    }

    if (!isValidURL(testTarget)) throw new Error(`Please provide a valid URL! ${testTarget} is not valid. Make sure to include "https://" or "http://"`);

    prepareRequestList();
    const requestList = await Apify.openRequestList('urls', REQUESTS);
    const requestQueue = await Apify.openRequestQueue();
    const proxyConfiguration = await Apify.createProxyConfiguration();

    Store.setState({ proxies: [] });

    const crawler = new Apify.CheerioCrawler({
        handlePageTimeoutSecs: 45,
        proxyConfiguration,
        requestQueue,
        requestList,
        useSessionPool: true,
        persistCookiesPerSession: false,
        maxRequestRetries: 0,
        ignoreSslErrors: true,
        additionalMimeTypes: ['text/plain'],
        autoscaledPoolOptions: {
            desiredConcurrency: 10,
        },
        handlePageFunction: async ({ $, request, json, body, crawler: { requestQueue: rq } }) => {
            switch (request.userData.label) {
                default:
                    break;

                case LABELS.FREEPROXYLISTNET: {
                    const freeProxiesPrx = getProxiesFromTable($, '.fpl-list tbody > tr');

                    addProxiesToStore(Store, freeProxiesPrx);
                    break;
                }

                case LABELS.GEONODECOM: {
                    const { data }: { data: { ip: string; port: string }[] } = json;
                    const geonodePrx = data.map(({ ip, port }) => {
                        return {
                            host: ip,
                            port: +port,
                            full: `${ip}:${port}`,
                        };
                    });

                    addProxiesToStore(Store, geonodePrx);
                    break;
                }

                case LABELS.SPYSME: {
                    const string = Buffer.from(body).toString();
                    let arr = string.split('\n').slice(6);
                    arr = arr.slice(6, arr.length - 2).map((item) => item.split(' ')[0]);
                    const spysMePrx = arr.map((item) => {
                        return {
                            host: item.split(':')[0],
                            port: +item.split(':')[1],
                            full: item,
                        };
                    });

                    addProxiesToStore(Store, spysMePrx);
                    break;
                }

                case LABELS.PROXYSCANIO: {
                    const prxArr = JSON.parse(Buffer.from(body).toString()) as { Ip: string; Port: number }[];
                    const proxyScanPrx = prxArr.map(({ Ip, Port }) => {
                        return {
                            host: Ip,
                            port: +`${Port}`,
                            full: `${Ip}:${Port}`,
                        };
                    });

                    addProxiesToStore(Store, proxyScanPrx);
                    break;
                }

                case LABELS.VPNOVERVIEW: {
                    const new$ = cheerio.load(body);
                    const vpnOverviewPrx = getProxiesFromTable(new$, 'table tbody > tr');

                    addProxiesToStore(Store, vpnOverviewPrx);
                    break;
                }

                case LABELS.HIDEMYNAME: {
                    const hideMyNamePrx = getProxiesFromTable($, '.table_block table tbody > tr');

                    addProxiesToStore(Store, hideMyNamePrx);
                    break;
                }

                case LABELS.PROXYNOVA: {
                    const proxyNovaPrx = getProxiesFromSneakyTable($, '#tbl_proxy_list tbody tr');

                    addProxiesToStore(Store, proxyNovaPrx);
                    break;
                }

                case LABELS.FREEPROXYLISTCOM: {
                    const rows = $('.proxy-list tbody > tr');
                    if (!rows.length) return;

                    const freeProxyListComPrx = getProxiesFromTable($, '.proxy-list tbody > tr', 0, 2);

                    addProxiesToStore(Store, freeProxyListComPrx);

                    const url = new URL(request.url);
                    const currentPage = url.searchParams.get('page');

                    if (currentPage) {
                        url.searchParams.set('page', `${+currentPage + 1}`);

                        await rq?.addRequest({ url: url.toString() });
                    }

                    break;
                }

                case LABELS.ANONYMOUSE: {
                    const anonymouseProxies = getProxiesFromTable($, 'table tbody > tr.text');

                    addProxiesToStore(Store, anonymouseProxies);
                    break;
                }

                case LABELS.CODERDUCK: {
                    let coderDuckProxies = getProxiesFromTable($, '.table tbody > tr', 1, 2);
                    coderDuckProxies = coderDuckProxies.map(<T extends ProxySchema>({ host, port, full }: T) => {
                        return {
                            host: host?.replace(/'|\s|\+|/g, '') || null,
                            port: port || null,
                            full: full?.replace(/'|\s|\+|/g, '') || null,
                        };
                    });
                    addProxiesToStore(Store, coderDuckProxies);
                    break;
                }

                case LABELS.PROXYFINDER: {
                    const { records } = json || {};

                    const onlineProxies = records.filter((proxy: { online: string }) => {
                        return proxy.online.toLowerCase().includes('yes');
                    });

                    addProxiesToStore(
                        Store,
                        onlineProxies.map(({ ip, port }: { ip: string; port: string }) => {
                            return {
                                host: ip as string,
                                port: +port as number,
                                full: `${ip}:${port}` as string,
                            };
                        }),
                    );
                    break;
                }

                case LABELS.PUBPROXY: {
                    const pubData: [] = json?.data || [];

                    if (!pubData.length) break;

                    const pubProxyPrx: Array<ProxySchema> = pubData.map(({ ip, port }: { ip: string; port: string }) => {
                        return {
                            host: ip,
                            port: +port,
                            full: `${ip}:${port}`,
                        };
                    });
                    addProxiesToStore(Store, pubProxyPrx);
                    break;
                }

                case LABELS.PROXYLISTDOWNLOAD: {
                    const bufferString = Buffer.from(body).toString();
                    const array: string[] = bufferString.split('\r\n');
                    array.pop();

                    const proxyListDownloadPrx = array.map((str) => {
                        const host = str.split(':')[0];
                        const port = +str.split(':')[1];

                        return {
                            host,
                            port,
                            full: `${host}:${port}`,
                        };
                    });

                    addProxiesToStore(Store, proxyListDownloadPrx);
                }
            }
        },
    });

    log.info('Starting the crawler...');
    await crawler.run();
    log.info('Crawler finished.');

    // Remove duplicates
    Store.setState((prev: State) => {
        const prevProxies = prev.proxies as ProxySchema[];
        return {
            ...prev,
            proxies: [
                ...prevProxies.filter((val, i, self) => {
                    return i === self.findIndex((obj) => obj.full === val.full);
                }),
            ],
        };
    });

    proxyLog.log(`Retrieved ${Store.getState().proxies.length} proxies.`);

    if (!testProxies) {
        proxyLog.log('Not testing proxies. Pushing to default dataset.');
        proxyLog.warn('It is highly recommended to set "testProxies" to be "true"');
        return Apify.pushData(Store.getState().proxies);
    }

    proxyLog.log(`Now testing all proxies with target ${testTarget} and timeout of ${testTimeout * 1000}ms`);

    const newProxies = await (async (): Promise<ProxySchema[]> => {
        const instance = axios.create({
            timeout: testTimeout * 1000,
        });

        let { proxies } = Store.state;

        const promises = [];
        for (const proxy of proxies) {
            promises.push(
                (() => {
                    return new Promise(async (resolve) => {
                        const firstResult = await testProxy(instance, testTarget, proxy);

                        // If it fails, run it again but with 'https' protocol
                        if (!firstResult) {
                            let newResult = await testProxy(instance, testTarget, proxy, true);
                            if (!newResult) {
                                proxyLog.test.failure(`${proxy?.full} failed test.`);
                                proxies = proxies.filter((prx: ProxySchema) => prx?.full && prx?.full !== proxy?.full);
                            } else {
                                proxyLog.test.success(`${proxy?.full} passed test.`);
                            }
                            return resolve(newResult);
                        }

                        proxyLog.test.success(`${proxy?.full} passed test.`);
                        resolve(firstResult);
                    });
                })()
            );
        }

        await Promise.all(promises);
        return proxies;
    })();

    proxyLog.storages(`${newProxies.length} reliable proxies retrieved.`);

    if (kvStore) {
        // Save JSON format to kvStore
        proxyLog.storages(`Pushing proxy data (JSON and TXT) to the named Key-Value store: ${kvStoreName}`);

        await kvStore.setValue('current-proxies', newProxies);

        let plainText = ``;
        newProxies.forEach(({ full }) => {
            plainText += `${full}\n`;
        });

        // Save txt format to kvStore
        await kvStore.setValue('current-proxies-txt', plainText, { contentType: 'text/plain' });
    }

    if (namedDataset) {
        proxyLog.storages(`Pushing to named dataset: ${datasetName}`);
        await namedDataset.pushData(newProxies);
    } else {
        proxyLog.storages(`Pushing to default dataset...`);
        await Apify.pushData(newProxies);
    }

    log.info('Done.');
});
