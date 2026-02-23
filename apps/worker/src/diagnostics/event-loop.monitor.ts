import { createLogger } from '@kodus/flow';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const logger = createLogger('EventLoopMonitor');
const NS_TO_MS = 1_000_000;
const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_WARN_P99_MS = 100;
const DEFAULT_RESOLUTION_MS = 20;

function parseBoolean(
    value: string | undefined,
    defaultValue: boolean,
): boolean {
    if (value === undefined) {
        return defaultValue;
    }
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseNumber(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function startEventLoopMonitor(): void {
    const enabled = parseBoolean(
        process.env.WORKER_EVENT_LOOP_MONITOR_ENABLED,
        true,
    );

    if (!enabled) {
        logger.log({
            message: 'Event loop monitor disabled by env',
            context: 'EventLoopMonitor',
        });
        return;
    }

    const intervalMs = parseNumber(
        process.env.WORKER_EVENT_LOOP_MONITOR_INTERVAL_MS,
        DEFAULT_INTERVAL_MS,
    );
    const warnP99Ms = parseNumber(
        process.env.WORKER_EVENT_LOOP_WARN_P99_MS,
        DEFAULT_WARN_P99_MS,
    );
    const resolutionMs = parseNumber(
        process.env.WORKER_EVENT_LOOP_RESOLUTION_MS,
        DEFAULT_RESOLUTION_MS,
    );

    const histogram = monitorEventLoopDelay({
        resolution: Math.max(10, Math.floor(resolutionMs)),
    });
    histogram.enable();

    let previousElu = performance.eventLoopUtilization();
    let tick = 0;

    const timer = setInterval(() => {
        const eluWindow = performance.eventLoopUtilization(previousElu);
        previousElu = performance.eventLoopUtilization();

        const p95Ms = histogram.percentile(95) / NS_TO_MS;
        const p99Ms = histogram.percentile(99) / NS_TO_MS;
        const maxMs = histogram.max / NS_TO_MS;
        const meanMs = histogram.mean / NS_TO_MS;
        const memory = process.memoryUsage();

        const metadata = {
            intervalMs,
            elu: Number(eluWindow.utilization.toFixed(4)),
            delayP95Ms: Number(p95Ms.toFixed(2)),
            delayP99Ms: Number(p99Ms.toFixed(2)),
            delayMaxMs: Number(maxMs.toFixed(2)),
            delayMeanMs: Number(meanMs.toFixed(2)),
            rssMB: Number((memory.rss / 1024 / 1024).toFixed(1)),
            heapUsedMB: Number((memory.heapUsed / 1024 / 1024).toFixed(1)),
        };

        if (p99Ms >= warnP99Ms) {
            logger.warn({
                message: 'Event loop lag above threshold',
                context: 'EventLoopMonitor',
                metadata,
            });
        } else if (tick % 6 === 0) {
            logger.log({
                message: 'Event loop health',
                context: 'EventLoopMonitor',
                metadata,
            });
        }

        histogram.reset();
        tick += 1;
    }, intervalMs);

    timer.unref();

    logger.log({
        message: 'Event loop monitor started',
        context: 'EventLoopMonitor',
        metadata: {
            intervalMs,
            warnP99Ms,
            resolutionMs: Math.max(10, Math.floor(resolutionMs)),
        },
    });
}
