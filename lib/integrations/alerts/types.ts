export type AlertCategory =
    | 'alarm'
    | 'lights'
    | 'spa'
    | 'fountain'
    | 'feeder'
    | 'humidity'
    | 'motion'
    | 'temperature'
    | 'washingMachine'
    | 'printer';

export interface AlertEvent {
    category: AlertCategory;
    /** Stable key used for throttling (same key = same throttle bucket). */
    throttleKey: string;
    /** Message sent to Telegram (HTML-formatted). */
    message: string;
    /**
     * Camera entity_ids to capture and attach to the Telegram message.
     * When set, the runner triggers snapshots, fetches the images, and dispatches
     * via sendMediaGroup instead of sendMessage.
     */
    photoCameras?: string[];
}

/** Snapshot persisted between runs to detect transitions. */
export interface AlertSnapshot {
    alarm?: {
        state?: string;
        lastChanged?: string;
        sirenOn?: boolean;
        sosLastUpdated?: string;
    };
    lights?: Record<string, boolean>; // area → anyOn
    humidity?: Record<string, { belowMin: boolean; aboveMax: boolean } | boolean>; // area → min/max status (or legacy boolean)
    temperature?: Record<string, { belowMin: boolean; aboveMax: boolean }>; // area → min/max status
    spa?: {
        belowThreshold?: boolean;
    };
    fountain?: {
        waterLow?: boolean;
    };
    feeder?: {
        food1Low?: boolean;
        food2Low?: boolean;
    };
    motion?: {
        /** entity_id → motion-on (last seen). */
        sensors?: Record<string, boolean>;
    };
    washingMachine?: {
        mode?: string;
        status?: string;
        error?: string | null;
        isFinished?: boolean;
    };
    printer?: {
        status?: string;
        filename?: string;
    };
}

export interface NotificationPreferences {
    alarm?: boolean;
    lights?: boolean;
    spa?: boolean;
    fountain?: boolean;
    feeder?: boolean;
    humidity?: boolean;
    motion?: boolean;
    temperature?: boolean;
    washingMachine?: boolean;
    printer?: boolean;
}
