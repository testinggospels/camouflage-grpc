import { log } from "@/core/logger";
import { CamoflageGrpcConfig, Hooks } from "@/core/config";
import path from 'path'
import fs from 'fs'
import os from 'os'
import * as grpc from '@grpc/grpc-js'
import { sleep } from "./sleep";
import Helpers from '@camoflage/helpers'
import { Counter, Histogram } from 'prom-client';

export interface CamoflageGrpcResponse {
    delay: number,
    error: Partial<grpc.StatusObject> | grpc.ServerErrorResponse | null,
    processedResponse: Record<any, any>
    headers: grpc.Metadata | null
    trailers: grpc.Metadata | null
}

export class CamoflageGrpcHandler {
    private config: CamoflageGrpcConfig
    private helpers: Helpers
    private grpcServerHandledTotal: Counter
    private grpcServerHandlingSeconds: Histogram
    private hooks: Hooks
    constructor(config: CamoflageGrpcConfig, hooks: Hooks) {
        this.config = config
        this.helpers = new Helpers()
        this.hooks = hooks
        this.grpcServerHandledTotal = new Counter({
            name: "grpc_server_handled_total",
            labelNames: ["grpc_code", "grpc_method", "grpc_type"],
            help: "Total number of RPCs completed on the server, regardless of success or failure.",
        })
        this.grpcServerHandlingSeconds = new Histogram({
            name: "grpc_server_handling_seconds",
            buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 10],
            labelNames: ["grpc_code", "grpc_method", "grpc_type"],
            help: "Histogram of response latency (seconds) of gRPC that had been application-level handled by the server.",
        })
    }
    public unaryHandler = async (call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) => {
        const startTime = process.hrtime();
        const handlerPath = call.getPath();
        const onRequestHooks = this.hooks[handlerPath]?.onRequest || [];
        const beforeResponseHooks = this.hooks[handlerPath]?.beforeResponse || [];
        const afterResponseHooks = this.hooks[handlerPath]?.afterResponse || [];
        if (onRequestHooks.length > 0) {
            for (let i = 0; i < onRequestHooks.length; i++) {
                await onRequestHooks[i](call)
            }
        }
        try {
            const mockFile = handlerPath.replace(/\./g, "/");
            const mockFilePath = path.join(this.config.mocksDir, mockFile + ".mock");
            if (fs.existsSync(mockFilePath)) {
                const content = this.helpers.parse(fs.readFileSync(mockFilePath, "utf-8").trim(), { request: call.request, metadata: call.metadata })
                const response = JSON.parse(content)
                const { delay, error, headers, trailers, processedResponse } = this.processResponse(response)
                if (beforeResponseHooks.length > 0) {
                    for (let i = 0; i < beforeResponseHooks.length; i++) {
                        await beforeResponseHooks[i](call, null, { delay, error, headers, trailers, processedResponse })
                    }
                }
                await sleep(delay)
                if (headers) call.sendMetadata(headers)
                if (trailers) {
                    callback(error, processedResponse, trailers)
                } else {
                    callback(error, processedResponse)
                }
                this.collectMetrics(startTime, error, handlerPath, "unary")
                if (afterResponseHooks.length > 0) {
                    for (let i = 0; i < afterResponseHooks.length; i++) {
                        await afterResponseHooks[i](call, null, { delay, error, headers, trailers, processedResponse })
                    }
                }
            } else {
                log.error(`No suitable mock file was found for ${mockFilePath}`);
                const error = { code: grpc.status.NOT_FOUND, message: `No suitable mock file was found for ${mockFilePath}` }
                callback(error, {});
                this.collectMetrics(startTime, error, handlerPath, "unary")
            }
        } catch (error: any) {
            log.error(error);
            const errorObj = { code: grpc.status.INTERNAL, message: error.message }
            callback(errorObj, {});
            this.collectMetrics(startTime, errorObj, handlerPath, "unary")
        }
    }
    public serverSideStreamingHandler = async (call: grpc.ServerWritableStream<any, any>) => {
        const startTime = process.hrtime();
        const handlerPath = call.getPath();
        const mockFile = handlerPath.replace(/\./g, "/");
        const mockFilePath = path.join(this.config.mocksDir, mockFile + ".mock");
        const onRequestHooks = this.hooks[handlerPath]?.onRequest || [];
        const beforeResponseHooks = this.hooks[handlerPath]?.beforeResponse || [];
        const afterResponseHooks = this.hooks[handlerPath]?.afterResponse || [];
        if (onRequestHooks.length > 0) {
            for (let i = 0; i < onRequestHooks.length; i++) {
                await onRequestHooks[i](call)
            }
        }
        if (fs.existsSync(mockFilePath)) {
            try {
                const content = this.helpers.parse(fs.readFileSync(mockFilePath, "utf-8").trim(), { request: call.request, metadata: call.metadata });
                const streamArr: string[] = content.split("====");
                streamArr.forEach(async (stream: any, index: number) => {
                    const parsedStream = JSON.parse(stream.replace(os.EOL, ""));
                    const { delay, error, headers, trailers, processedResponse } = this.processResponse(parsedStream);
                    if (beforeResponseHooks.length > 0) {
                        for (let i = 0; i < beforeResponseHooks.length; i++) {
                            await beforeResponseHooks[i](call, null, { delay, error, headers, trailers, processedResponse })
                        }
                    }
                    await sleep(delay);
                    if (headers) call.sendMetadata(headers);
                    if (error) call.emit('error', error);
                    call.write(processedResponse);
                    if (trailers) call.sendMetadata(trailers);
                    if (index == streamArr.length - 1) {
                        call.end();
                    }
                    this.collectMetrics(startTime, error, handlerPath, "server-stream")
                    if (afterResponseHooks.length > 0) {
                        for (let i = 0; i < afterResponseHooks.length; i++) {
                            await afterResponseHooks[i](call, null, { delay, error, headers, trailers, processedResponse })
                        }
                    }
                })
            } catch (error: any) {
                log.error(error);
                const errorObj = { code: grpc.status.INTERNAL, message: error.message }
                call.emit("error", errorObj)
                call.end();
                this.collectMetrics(startTime, errorObj, handlerPath, "server-stream")
            }
        } else {
            log.error(`No suitable mock file was found for ${mockFilePath}`);
            const error = { code: grpc.status.NOT_FOUND, message: `No suitable mock file was found for ${mockFilePath}` }
            call.write(error);
            call.end();
            this.collectMetrics(startTime, error, handlerPath, "server-stream")
        }
    }
    public clientSideStreamingHandler = (call: grpc.ServerReadableStream<any, any>, callback: grpc.sendUnaryData<any>) => {
        const handlerPath = call.getPath();
        const requests: any[] = [];
        call.on('data', async (data: any) => {
            const onRequestHooks = this.hooks[handlerPath]?.onRequest || [];
            if (onRequestHooks.length > 0) {
                for (let i = 0; i < onRequestHooks.length; i++) {
                    await onRequestHooks[i](call, data)
                }
            }
            requests.push(data);
        })
        call.on('end', async () => {
            const startTime = process.hrtime()
            const beforeResponseHooks = this.hooks[handlerPath]?.beforeResponse || [];
            const afterResponseHooks = this.hooks[handlerPath]?.afterResponse || [];
            try {
                const mockFile = handlerPath.replace(/\./g, "/");
                const mockFilePath = path.join(this.config.mocksDir, mockFile + ".mock");
                if (fs.existsSync(mockFilePath)) {
                    const content = this.helpers.parse(fs.readFileSync(mockFilePath, "utf-8").trim(), { request: requests, metadata: call.metadata });
                    const response = JSON.parse(content);
                    const { delay, error, headers, trailers, processedResponse } = this.processResponse(response);
                    if (beforeResponseHooks.length > 0) {
                        for (let i = 0; i < beforeResponseHooks.length; i++) {
                            await beforeResponseHooks[i](call, requests, { delay, error, headers, trailers, processedResponse })
                        }
                    }
                    await sleep(delay);
                    if (headers) call.sendMetadata(headers);
                    if (trailers) {
                        callback(error, processedResponse, trailers);
                    } else {
                        callback(error, processedResponse);
                    }
                    this.collectMetrics(startTime, error, handlerPath, "client-stream")
                    if (afterResponseHooks.length > 0) {
                        for (let i = 0; i < afterResponseHooks.length; i++) {
                            await afterResponseHooks[i](call, requests, { delay, error, headers, trailers, processedResponse })
                        }
                    }
                } else {
                    log.error(`No suitable mock file was found for ${mockFilePath}`);
                    const error = { code: grpc.status.NOT_FOUND, message: `No suitable mock file was found for ${mockFilePath}` }
                    callback(error, {});
                    this.collectMetrics(startTime, error, handlerPath, "client-stream")
                }
            } catch (error: any) {
                log.error(error);
                const err = { code: grpc.status.INTERNAL, message: error.message }
                callback(err, {});
                this.collectMetrics(startTime, error, handlerPath, "client-stream")

            }
        })
    }
    public bidiStreamingHandler = (call: grpc.ServerDuplexStream<any, any>) => {
        let startTime = process.hrtime()
        const handlerPath = call.getPath();
        const mockFile = handlerPath.replace(/\./g, "/");
        const mockFilePath = path.join(this.config.mocksDir, mockFile + ".mock");
        const onRequestHooks = this.hooks[handlerPath]?.onRequest || [];
        const beforeResponseHooks = this.hooks[handlerPath]?.beforeResponse || [];
        const afterResponseHooks = this.hooks[handlerPath]?.afterResponse || [];
        const requests: any[] = [];
        if (!fs.existsSync(mockFilePath)) {
            log.error(`No suitable mock file was found for ${mockFilePath}`);
            const error = { code: grpc.status.NOT_FOUND, message: `No suitable mock file was found for ${mockFilePath}` }
            call.write(error);
            call.end();
            this.collectMetrics(startTime, error, handlerPath, "bidi-stream")
            return;
        }
        call.on('data', async (data: any) => {
            if (onRequestHooks.length > 0) {
                for (let i = 0; i < onRequestHooks.length; i++) {
                    await onRequestHooks[i](call, data)
                }
            }
            startTime = process.hrtime()
            try {
                requests.push(data);
                const content = this.helpers.parse(fs.readFileSync(mockFilePath, "utf-8").trim(), { request: data, metadata: call.metadata });
                const response = JSON.parse(content);
                const { delay, error, headers, trailers, processedResponse } = this.processResponse(response.data);
                if (beforeResponseHooks.length > 0) {
                    for (let i = 0; i < beforeResponseHooks.length; i++) {
                        await beforeResponseHooks[i](call, data, { delay, error, headers, trailers, processedResponse })
                    }
                }
                await sleep(delay);
                if (headers) call.sendMetadata(headers);
                if (error) call.emit('error', error);
                call.write(processedResponse);
                if (trailers) call.sendMetadata(trailers);
                this.collectMetrics(startTime, error, handlerPath, "bidi-stream")
                if (afterResponseHooks.length > 0) {
                    for (let i = 0; i < afterResponseHooks.length; i++) {
                        await afterResponseHooks[i](call, data, { delay, error, headers, trailers, processedResponse })
                    }
                }
            } catch (error: any) {
                log.error(error);
                const err = { code: grpc.status.INTERNAL, message: error.message }
                call.emit('error', err);
                this.collectMetrics(startTime, err, handlerPath, "bidi-stream")
                call.end();
            }
        });
        call.on('end', async () => {
            startTime = process.hrtime()
            try {
                const content = this.helpers.parse(fs.readFileSync(mockFilePath, "utf-8").trim(), { request: requests, metadata: call.metadata });
                const response = JSON.parse(content);
                if (response.end) {
                    const { delay, error, headers, trailers, processedResponse } = this.processResponse(response.end);
                    await sleep(delay);
                    if (headers) call.sendMetadata(headers);
                    if (error) call.emit('error', error);
                    call.write(processedResponse);
                    if (trailers) call.sendMetadata(trailers);
                    this.collectMetrics(startTime, error, handlerPath, "bidi-stream")
                } else {
                    const error = { code: grpc.status.OK }
                    this.collectMetrics(startTime, error, handlerPath, "bidi-stream")
                    call.end();
                }
            } catch (error: any) {
                log.error(error);
                const err = { code: grpc.status.INTERNAL, message: error.message }
                call.emit('error', err);
                call.end();
                this.collectMetrics(startTime, err, handlerPath, "bidi-stream")
            }
        })
    }
    private processResponse = (response: any): CamoflageGrpcResponse => {
        const delay = response.delay || 0
        delete response.delay;
        const error = response.error || null
        delete response.error;
        let headers = null
        let trailers = null;
        if (response.metadata) {
            const headerMetadata = response.metadata.headers || null;
            const trailerMetadata = response.metadata.trailers || null;
            delete response.metadata;
            if (headerMetadata) {
                headers = new grpc.Metadata();
                for (const key in headerMetadata) {
                    if (key.endsWith("-bin")) {
                        headers.add(key, Buffer.from(headerMetadata[key], "base64"))
                    } else {
                        headers.add(key, headerMetadata[key])
                    }
                }
            }
            if (trailerMetadata) {
                trailers = new grpc.Metadata()
                for (const key in trailerMetadata) {
                    if (key.endsWith("-bin")) {
                        trailers.add(key, Buffer.from(trailerMetadata[key], "base64"))
                    } else {
                        trailers.add(key, trailerMetadata[key])
                    }
                }
            }
        }
        const processedResponse = response
        return { delay, error, headers, trailers, processedResponse }
    }
    private getElapsedMilliseconds = (startTime: [number, number]) => {
        const diff = process.hrtime(startTime);
        return diff[0] * 1e3 + diff[1] * 1e-6;
    };
    private collectMetrics = (startTime: [number, number], error: any, grpc_method: string, grpc_type: string) => {
        if (error && error.code) {
            this.grpcServerHandledTotal.labels(error.code, grpc_method, grpc_type).inc()
            this.grpcServerHandlingSeconds.labels(error.code, grpc_method, grpc_type).observe(this.getElapsedMilliseconds(startTime) / 1000)
        } else {
            this.grpcServerHandledTotal.labels("0", grpc_method, grpc_type).inc()
            this.grpcServerHandlingSeconds.labels("0", grpc_method, grpc_type).observe(this.getElapsedMilliseconds(startTime) / 1000)
        }
    }
}
