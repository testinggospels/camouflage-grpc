import { CamoflageGrpcConfig, CamoflageGrpcHook, Hooks, isConfigValid } from "./config";
import { log } from "./logger";
import path from 'path';
import fs from 'fs';
import * as grpc from "@grpc/grpc-js";
import { CamoflageGrpcHandler } from "@/utils/handlers";
import Helpers from '@camoflage/helpers'
import { registerCustomHelpers } from "@/helpers";
import * as client from 'prom-client';
import http from 'http';

export default class CamoflageGrpc {
    private config: CamoflageGrpcConfig | null = null
    private server: grpc.Server;
    private handlers: CamoflageGrpcHandler | undefined
    private helpers: Helpers;
    private hooks: Hooks = {};
    constructor(config?: CamoflageGrpcConfig) {
        if (config) {
            const isValid: boolean = isConfigValid(config)
            if (isValid) {
                this.config = config
                log.debug(this.config);
                this.config.mocksDir = path.resolve(this.config.mocksDir)
                this.handlers = new CamoflageGrpcHandler(this.config, this.hooks)
            } else {
                log.error('Invalid config!');
                process.exit(1)
            }
        }
        this.server = new grpc.Server();
        this.helpers = new Helpers()
        registerCustomHelpers(this.helpers)
        client.collectDefaultMetrics()
    }
    public loadConfigFromJson = (configFilePath: string): void => {
        if (this.config) log.warn("Config was already loaded. This action will overwrite existing config.")
        const absolutePath = path.resolve(configFilePath);
        if (fs.existsSync(absolutePath)) {
            const configData = JSON.parse(fs.readFileSync(absolutePath, 'utf-8')) as CamoflageGrpcConfig;
            const isValid: boolean = isConfigValid(configData)
            if (isValid) {
                this.config = configData
                log.debug(this.config);
                this.config.mocksDir = path.resolve(this.config.mocksDir)
                this.handlers = new CamoflageGrpcHandler(this.config, this.hooks)
            } else {
                log.error('Invalid config file!');
                process.exit(1)
            }
        } else {
            log.error("File not found", path.resolve(absolutePath))
            process.exit(1)
        }
    }
    public getHandlers = (): CamoflageGrpcHandler | undefined => {
        return this.handlers
    }
    public getHelpers = () => {
        return this.helpers
    }
    public addService = (service: grpc.ServiceDefinition<grpc.UntypedServiceImplementation>, implementation: grpc.UntypedServiceImplementation): void => {
        this.server.addService(service, implementation)
    }
    public addHook = (fullPath: string, event: "onRequest" | "beforeResponse" | "afterResponse", fn: CamoflageGrpcHook): void => {
        if (!this.hooks[fullPath]) {
            this.hooks[fullPath] = {};
        }
        if (!this.hooks[fullPath][event]) {
            this.hooks[fullPath][event] = [];
        }
        this.hooks[fullPath][event]?.push(fn);
    }
    public start = async (): Promise<void> => {
        if (!this.config) {
            log.fatal("Error: Config file MIA. Oh well, can't do much without it. Buh-bye")
            process.exit(1)
        }
        this.server.bindAsync(`${this.config.host}:${this.config.port}`, this.serverCredentials(this.config.ssl.enable, this.config.ssl.cert, this.config.ssl.key, this.config.ssl.rootCert), (err) => {
            if (err) log.error(err.message);
            log.info(`Ask and you shall recieve a gRPC server @ ${this.config?.host}:${this.config?.port}`);
            this.server.start();
        });
        this.initMetricsServer()
    }
    public stop = async (): Promise<void> => {
        this.server.tryShutdown((err) => {
            log.error(err)
            this.server.forceShutdown()
        })
    }
    private serverCredentials = (enable: boolean, certPath: string, keyPath: string, rootCert?: string): grpc.ServerCredentials => {
        if (!enable) {
            log.debug(`Using insecure gRPC server credentials.`);
            return grpc.ServerCredentials.createInsecure()
        }
        const keyCertPairs = [{
            private_key: fs.readFileSync(keyPath),
            cert_chain: fs.readFileSync(certPath)
        }]
        if (rootCert && fs.existsSync(rootCert)) {
            log.debug(`Using SSL gRPC server credentials with client authentication.`);
            return grpc.ServerCredentials.createSsl(fs.readFileSync(rootCert), keyCertPairs, true)
        } else {
            log.debug(`Using SSL gRPC server credentials without client authentication.`);
            return grpc.ServerCredentials.createSsl(null, keyCertPairs, false);
        }
    }
    private initMetricsServer = () => {
        if (this.config && this.config.monitoring && this.config.monitoring.enable) {
            const server = http.createServer(async (req, res) => {
                // Serve Prometheus metrics at the /metrics endpoint
                if (req.url === '/metrics') {
                    res.writeHead(200, { 'Content-Type': client.register.contentType });
                    const metrics = await client.register.metrics()
                    res.end(metrics);
                } else {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('Not Found');
                }
            });
            server.listen(this.config.monitoring.port, () => {
                if (this.config && this.config.monitoring && this.config.monitoring.enable)
                    console.log(`Server listening on http://localhost:${this.config.monitoring.port}`);
            });
        }
    }
}