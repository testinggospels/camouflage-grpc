import { log } from '@/core/logger'
import jsonpath from "jsonpath";

export const RequestHelper = (context: any) => {
    const request: any = context.data.root.request;
    const metadata: any = context.data.root.metadata;
    const from: string = context.hash.from;
    switch (from) {
        case "metadata":
            if (!context.hash.key) {
                log.error("ERROR: No key specified");
                return null
            }
            return metadata.get(context.hash.key) || null;
        case "request":
            if (!context.hash.using || !context.hash.selector) {
                log.error("ERROR: No selector or using values specified");
                return null;
            } else {
                switch (context.hash.using) {
                    case "regex": {
                        const regex = new RegExp(context.hash.selector);
                        const body = JSON.stringify(request, null, 2);
                        const match = regex.exec(body)
                        if (match) {
                            return match[1]
                        }
                        log.error(`ERROR: No match found for specified regex ${context.hash.selector}`);
                        return null;
                    }
                    case "jsonpath": {
                        try {
                            return jsonpath.query(request, context.hash.selector);
                        } catch (err) {
                            log.error(`ERROR: No match found for specified jsonpath ${context.hash.selector}`);
                            log.error(`ERROR: ${err}`);
                            return null;
                        }
                    }
                    default:
                        return null;
                }
            }
        default:
            return null;
    }
}