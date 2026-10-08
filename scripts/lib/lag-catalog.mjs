/**
 * A copy of the lag metric and event catalog
 * (lag/packages/lag/src/metric-catalog.ts): names, kinds, units and the
 * permitted attribute values. The sample-data, dashboard and verification
 * scripts use it. `node scripts/verify-pipeline.mjs --catalog <path>`
 * compares it with the TypeScript catalog.
 */

const LIFECYCLE_STATES = ["active", "passive", "hidden", "frozen", "terminated"];
const LIFECYCLE_TRIGGERS = ["focus", "blur", "visibilitychange", "freeze", "resume", "pagehide", "pageshow"];
const INTERACTION_TYPES = ["pointer", "keyboard", "other"];
const PRESSURE_SOURCES = ["cpu", "thermals", "power", "memory"];

export const NAVIGATION_TYPES = [
    "navigate", "reload", "back-forward", "back-forward-cache", "prerender", "restore", "soft-navigation",
];

function metric(key, name, kind, unit, attributes = {}) {
    return { key, name, kind, unit, attributes };
}

/** Every metric of the catalog, in catalog order. */
export const METRICS = [
    metric("drift", "lag_drift_histogram", "histogram", "ms"),
    metric("driftBaseline", "lag_drift_baseline_histogram", "histogram", "ms"),
    metric("macrotask", "lag_macrotask_histogram", "histogram", "ms"),

    metric("samplesDiscarded", "lag_samples_discarded", "counter", "{sample}", { reason : ["hidden", "frozen", "suspend"] }),
    metric("stalls", "lag_stalls", "counter", "{stall}", { kind : ["hang", "suspend"] }),
    metric("stallDuration", "lag_stall_duration_histogram", "histogram", "ms", { kind : ["hang", "suspend"] }),

    metric("workerMainBlock", "lag_worker_main_block_histogram", "histogram", "ms"),
    metric("workerSelfLag", "lag_worker_self_lag_histogram", "histogram", "ms"),
    metric("workerClockOffset", "lag_worker_clock_offset_histogram", "histogram", "ms"),
    metric("hangs", "lag_main_thread_hangs", "counter", "{hang}", { outcome : ["ended", "abandoned"] }),
    metric("hangDuration", "lag_main_thread_hang_duration_histogram", "histogram", "ms", { outcome : ["ended", "abandoned"] }),

    metric("loafBlocking", "lag_loaf_blocking_histogram", "histogram", "ms"),
    metric("loafDuration", "lag_loaf_duration_histogram", "histogram", "ms"),

    metric("eventDuration", "lag_event_duration_histogram", "histogram", "ms", { interaction : INTERACTION_TYPES }),
    metric("eventInputDelay", "lag_event_input_delay_histogram", "histogram", "ms", { interaction : INTERACTION_TYPES }),
    metric("eventProcessing", "lag_event_processing_histogram", "histogram", "ms", { interaction : INTERACTION_TYPES }),
    metric("eventPresentationDelay", "lag_event_presentation_delay_histogram", "histogram", "ms", { interaction : INTERACTION_TYPES }),

    metric("layoutShift", "lag_layout_shift_histogram", "histogram", "1"),

    metric("vitalInp", "lag_web_vital_inp_histogram", "histogram", "ms", { navigation_type : NAVIGATION_TYPES }),
    metric("vitalCls", "lag_web_vital_cls_histogram", "histogram", "1", { navigation_type : NAVIGATION_TYPES }),
    metric("vitalLcp", "lag_web_vital_lcp_histogram", "histogram", "ms", { navigation_type : NAVIGATION_TYPES }),
    metric("vitalFcp", "lag_web_vital_fcp_histogram", "histogram", "ms", { navigation_type : NAVIGATION_TYPES }),
    metric("vitalTtfb", "lag_web_vital_ttfb_histogram", "histogram", "ms", { navigation_type : NAVIGATION_TYPES }),

    metric("frameDelta", "lag_frame_delta_histogram", "histogram", "ms"),
    metric("frames", "lag_frames", "counter", "{frame}", { outcome : ["delivered", "dropped"] }),

    metric("idleTimeRemaining", "lag_idle_time_remaining_histogram", "histogram", "ms"),
    metric("idleGap", "lag_idle_gap_histogram", "histogram", "ms"),
    metric("idleCallbacks", "lag_idle_callbacks", "counter", "{callback}", { timed_out : ["true", "false"] }),

    metric("schedulingMicrotask", "lag_scheduling_microtask_histogram", "histogram", "ms"),
    metric("schedulingMacrotask", "lag_scheduling_macrotask_histogram", "histogram", "ms"),
    metric("schedulingMessageChannel", "lag_scheduling_message_channel_histogram", "histogram", "ms"),

    metric("memoryUsed", "lag_memory_used_bytes_histogram", "histogram", "By", { source : ["modern", "legacy"] }),
    metric("memoryUsage", "lag_memory_usage_ratio_histogram", "histogram", "1"),

    metric("pressureState", "lag_pressure_state_histogram", "histogram", "1", { source : PRESSURE_SOURCES }),

    metric("gcEvents", "lag_gc_events", "counter", "{gc}"),

    metric("lifecycleTransitions", "lag_lifecycle_transitions", "counter", "{transition}", {
        from : LIFECYCLE_STATES,
        to : LIFECYCLE_STATES,
        trigger : LIFECYCLE_TRIGGERS,
    }),

    metric("timerCalibrations", "lag_timer_calibrations", "counter", "{calibration}", { throttled : ["true", "false"] }),

    metric("clockResolution", "lag_clock_resolution_histogram", "histogram", "ms"),
    metric("clockSkew", "lag_clock_skew_histogram", "histogram", "ms"),
    metric("clockJumps", "lag_clock_jumps", "counter", "{jump}", { direction : ["forward", "backward"], kind : ["suspend", "step"] }),

    metric("browserReports", "lag_browser_reports", "counter", "{report}", { type : ["intervention", "deprecation"] }),

    metric("livenessBlock", "lag_liveness_block_histogram", "histogram", "ms"),
];

/** Metric key to definition. */
export const M = Object.fromEntries(METRICS.map(m => [m.key, m]));

/** Every event of the catalog. Every event also has `lag.page_view.id`. */
export const EVENTS = [
    {
        name : "browser.web_vital",
        attributes : [
            "browser.web_vital.name", "browser.web_vital.value", "browser.web_vital.delta", "browser.web_vital.id",
            "browser.web_vital.rating", "browser.web_vital.navigation_type", "lag.page_view.id", "lag.page_view.url",
            "lag.web_vital.*",
        ],
    },
    { name : "lag.main_thread.hang", attributes : ["phase", "duration_ms", "lag.hang.page_id", "lag.page_view.id"] },
    { name : "lag.clock.jump", attributes : ["direction", "kind", "magnitude_ms", "skew_ms", "lateness_ms", "lag.page_view.id"] },
    {
        name : "lag.long_animation_frame",
        attributes : ["duration_ms", "blocking_duration_ms", "script.invoker", "script.invoker_type", "script.source_url", "script.duration_ms", "lag.page_view.id"],
    },
    { name : "lag.browser_report", attributes : ["type", "id", "message", "source_file", "line_number", "lag.page_view.id"] },
    { name : "lag.stall", attributes : ["kind", "duration_ms", "lag.page_view.id"] },
];

/** Good and poor thresholds of the vitals. A value at or below `good` is good; a value above `poor` is poor. */
export const VITAL_THRESHOLDS = {
    inp : { good : 200, poor : 500, unit : "ms" },
    cls : { good : 0.1, poor : 0.25, unit : "1" },
    lcp : { good : 2_500, poor : 4_000, unit : "ms" },
    fcp : { good : 1_800, poor : 3_000, unit : "ms" },
    ttfb : { good : 800, poor : 1_800, unit : "ms" },
};
