/**
 * Structured Logging Engine
 * Provides categorized logging for API requests, Home Assistant calls, and security events.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
    /** Request ID for correlation */
    requestId?: string;
    /** User identifier */
    userId?: string;
    /** User email */
    userEmail?: string;
    /** Entity being accessed */
    entityId?: string;
    /** HTTP method */
    method?: string;
    /** Request path */
    path?: string;
    /** Response status code */
    status?: number;
    /** Duration in milliseconds */
    durationMs?: number;
    /** IP address */
    ip?: string;
    /** Additional custom fields */
    [key: string]: unknown;
}

interface StructuredLog {
    timestamp: string;
    level: LogLevel;
    message: string;
    service: string;
    environment: string;
    context: LogContext;
}

// Configuration
const SERVICE_NAME = 'home-back';
const ENVIRONMENT = process.env.NODE_ENV || 'development';
const LOG_FORMAT = process.env.LOG_FORMAT || 'json'; // 'json' or 'pretty'

/**
 * Format log entry based on environment
 */
function formatLog(log: StructuredLog): string {
    if (LOG_FORMAT === 'pretty' || ENVIRONMENT === 'development') {
        // Human-readable format for development
        const emoji = {
            debug: '🔍',
            info: 'ℹ️ ',
            warn: '⚠️',
            error: '❌',
        }[log.level];

        const time = new Date(log.timestamp).toLocaleTimeString('fr-FR', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });

        const contextStr = Object.entries(log.context)
            .filter(([_, v]) => v !== undefined)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ');

        return `[${time}] ${emoji} ${log.message} ${contextStr}`;
    }

    // JSON format for production
    return JSON.stringify(log);
}

/**
 * Create a structured log entry
 */
function createLog(level: LogLevel, message: string, context: LogContext = {}): void {
    const log: StructuredLog = {
        timestamp: new Date().toISOString(),
        level,
        message,
        service: SERVICE_NAME,
        environment: ENVIRONMENT,
        context,
    };

    const formatted = formatLog(log);

    switch (level) {
        case 'debug':
            console.debug(formatted);
            break;
        case 'info':
            console.info(formatted);
            break;
        case 'warn':
            console.warn(formatted);
            break;
        case 'error':
            console.error(formatted);
            break;
    }
}

// ============================================
// Public API
// ============================================

export const logger = {
    debug: (message: string, context?: LogContext) => createLog('debug', message, context),
    info: (message: string, context?: LogContext) => createLog('info', message, context),
    warn: (message: string, context?: LogContext) => createLog('warn', message, context),
    error: (message: string, context?: LogContext) => createLog('error', message, context),

    /**
     * Log an API request start
     */
    apiRequest: (context: LogContext) => {
        // The completion line (apiResponse) already carries path, status and duration
        createLog('debug', 'API Request', {
            ...context,
            event: 'api.request.start',
        });
    },

    /**
     * Log an API request completion
     */
    apiResponse: (context: LogContext) => {
        const level = context.status && context.status >= 400 ? 'warn' : 'info';
        createLog(level, 'API Response', {
            ...context,
            event: 'api.request.complete',
        });
    },

    /**
     * Log a security event (auth failures, permission denials)
     */
    security: (message: string, context: LogContext) => {
        createLog('warn', message, {
            ...context,
            event: 'security',
        });
    },

    /**
     * Log a rate limit event
     */
    rateLimit: (context: LogContext) => {
        createLog('warn', 'Rate limit exceeded', {
            ...context,
            event: 'rate_limit',
        });
    },

    /**
     * Log a Home Assistant API call
     */
    haCall: (context: LogContext & { haPath?: string; haMethod?: string }) => {
        createLog('debug', 'Home Assistant API Call', {
            ...context,
            event: 'ha.api.call',
        });
    },
};

export default logger;
