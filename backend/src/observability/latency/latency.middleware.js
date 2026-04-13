import { startTimer, endTimer } from "./latency.service.js";


export function latencyMiddleware(req, res, next) {
    const start = startTimer();

    res.on("finish", () => {
        endTimer("http.request", start, {
            method: req.method,
            path: req.route?.path || req.path,
            statusCode: res.statusCode,
        });
    });

    next();
}