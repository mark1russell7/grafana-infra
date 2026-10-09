# grafana-infra

This repository is a Docker Compose stack for frontend observability. It has Grafana Alloy, Mimir, Loki, Tempo, Pyroscope and Grafana. The lag library uses it for development and integration tests, as the devDependency `@mark1russell7/grafana-infra`. The stack provisions the Lag Monitor dashboard.

## Components

| Service | Image | Host port | Function |
|---|---|---|---|
| Alloy | `grafana/alloy:v1.20.1` | 4318 (OTLP/HTTP), 4317 (OTLP/gRPC), 12345 (UI) | Receives OTLP data from browsers and sends it to the backends. |
| Mimir | `grafana/mimir:3.2.2` | 9009 | Stores the metrics and evaluates the recording rules. |
| Loki | `grafana/loki:3.6.0` | 3100 | Stores the logs and the events. |
| Tempo | `grafana/tempo:2.7.2` | 3200 | Stores the traces. |
| Pyroscope | `grafana/pyroscope:latest` | 4040 | Stores the profiles. |
| Grafana | `grafana/grafana:13.0.10` | 3000 | Shows the dashboards. |

The Mimir, Alloy and Grafana images have fixed versions. The Mimir configuration uses experimental options, and a new Mimir version can change their names.

## Start and stop the stack

1. Start the stack:

   ```sh
   docker compose up -d
   ```

2. Open Grafana at <http://localhost:3000>.
3. Edit the dashboards as an anonymous user, or sign in as `admin` with the password `admin`. `config/grafana/grafana.ini` gives anonymous users the Admin role. Use this setting only on your own computer.
4. Stop the stack:

   ```sh
   docker compose down
   ```

The data stays in Docker volumes. To delete the data, add `-v` to the `docker compose down` command.

The file `.env` sets the host ports. If a port is in use, set a different port in the environment. This example moves Grafana to port 3300:

```sh
GRAFANA_PORT=3300 docker compose up -d
```

## The pipeline

```text
browser (OpenTelemetry JS SDK)
  │  OTLP/HTTP, JSON or protobuf, port 4318
  ▼
Alloy: otelcol.receiver.otlp (CORS for localhost pages)
  ├─ metrics ──────────────────────────────► batch ──► Mimir  /otlp/v1/metrics
  ├─ logs ──► transform (event name, line) ──► batch ──► Loki   /otlp/v1/logs
  └─ traces ───────────────────────────────► batch ──► Tempo  OTLP/gRPC
```

Alloy keeps no state. A restart of Alloy loses no metric data, because browsers export cumulative values. Traces go to `/v1/traces` on the same port, as metrics and logs.

### Alloy

- The OTLP receiver accepts OTLP/HTTP (JSON and protobuf) on port 4318 and OTLP/gRPC on port 4317.
- Pages on `localhost` and `127.0.0.1` can post, on all ports, through HTTP or HTTPS.
- The receiver answers the CORS preflight. It echoes the page origin and lets the page send credentials.
- The lag worker sends hang reports with `fetch(url, { keepalive: true })` and a JSON body. This request gets a preflight, and the receiver accepts it.
- `navigator.sendBeacon` with a JSON body also works.
- To accept a different origin, add it to `allowed_origins` in `config/alloy/config.alloy`.

The `transform` processor prepares the log records for Loki:

- Loki 3.6 and 3.7 ignore the `EventName` field of an OTLP log record. Alloy copies the event name to the log attribute `event.name`.
- Loki drops an entry when the previous entry of its stream has the same timestamp and the same line. Event records often have no body. For these records, Alloy writes the attributes into the line.

### Mimir

Mimir translates each OTLP metric to Prometheus series:

- `service.name` becomes the `job` label. With `service.namespace`, the `job` label is `<namespace>/<name>`.
- `service.instance.id` becomes the `instance` label.
- The other resource attributes go to the `target_info` series.
- The metric names do not change. Mimir adds no unit suffix and no `_total` suffix, because `otel_metric_suffixes_enabled` is false.
- For example, `lag_drift_histogram` (unit `ms`) stays `lag_drift_histogram`, and the counter `lag_stalls` stays `lag_stalls`.
- An exponential histogram becomes one native histogram series. It has no `_bucket`, `_sum` or `_count` series.

PromQL shows an info notice for `rate()` on a counter without the `_total` suffix. The notice has no effect on the result.

These settings are in `config/mimir/mimir.yaml`:

| Setting | Value | Function |
|---|---|---|
| `native_histograms_ingestion_enabled` | `true` | Stores exponential histograms as native histograms. |
| `otel_created_timestamp_zero_ingestion_enabled` (experimental) | `true` | Adds a zero sample at the start time of a new series. Then `rate()` also counts the first export of a page load. |
| `promote_otel_resource_attributes` (experimental) | `service.name`, `service.namespace`, `service.version`, `deployment.environment.name`, `browser.platform`, `browser.mobile` | Copies these resource attributes to labels on each series. They are constant for an SDK instance, so they add no series. |
| `out_of_order_time_window` | `10m` | Accepts samples up to 10 minutes late, from retries and final exports. |
| `max_global_series_per_user` | `500000` | Sets the series budget of the tenant. |
| `max_global_series_per_metric` | `100000` | Sets the series budget of one metric. |
| `query_scheduler.max_outstanding_requests_per_tenant` | `4096` | Lets the Lag Monitor dashboard send all its queries at the same time. |

Do not promote `session.id`. Each session then gets its own series, and `session.id` is not a correct writer identity.

#### Series budget

The limits use this rule: in-memory series = R × 2.5 h × S.

- S is the number of series of one SDK instance. The lag catalog has 42 metrics.
- With native histograms, one page load has approximately 85 series and one `target_info` series. Then S = 100.
- R is the number of SDK instances in one hour. This stack plans for 2,000 page loads in one hour.
- The series of a closed page stay in memory until the next head compaction. For this reason, the rule uses 2.5 h.
- 2,000 × 2.5 × 100 = 500,000.

For more traffic, increase the limits. Explicit-bucket histograms make S more than 10 times larger.

### Loki

- The index labels are `service_name` and `event_name`. Both have few values.
- All other attributes go to structured metadata.
- Loki changes the dots in attribute names to underscores. For example, `service.instance.id` becomes `service_instance_id`.
- Other examples: `session.id` becomes `session_id`, and `browser.web_vital.value` becomes `browser_web_vital_value`.
- The configuration is `limits_config.otlp_config` in `config/loki/loki.yaml`.

This LogQL query gives the p75 of each Web Vital in 5-minute windows:

```logql
quantile_over_time(0.75,
  {service_name="shop", event_name="browser.web_vital"}
  | keep browser_web_vital_name, browser_web_vital_value
  | unwrap browser_web_vital_value [5m]) by (browser_web_vital_name)
```

### Tempo: the traces of the page views

With a span sink (`createOtelSpanSink`), the lag library sends one trace for each page view:

- The root span `lag.page_view` starts at the start of the view. It ends when the page is hidden for the first time in the view, or at the end of the view. The browser can discard a hidden page without an event, and the exporter sends only the spans that ended. At its end, the span gets the values of the Web Vitals as attributes, for example `lag.web_vital.lcp`.
- The other spans are in the span of the view: `lag.main_thread.hang`, `lag.stall`, `lag.long_animation_frame`, `lag.page.hidden` and `lag.page.frozen`. Each one has the real start and end of its period. An event of the same period gives only the start and the duration.
- An abandoned hang that another page reports is in the trace of the page that hung. Its span has a link to the view of the page that reported it.
- The `lag.page_view.start` event has the identity of the span of the view: `lag.page_view.trace_id` and `lag.page_view.span_id`. Only a sampled span gives them. Loki keeps them as the structured metadata `lag_page_view_trace_id` and `lag_page_view_span_id`.
- The spans have the same resource as the metrics and the logs: `service.name` and `service.instance.id`. otel-ts puts `session.id` on each span.

The dashboards and the alerts use the events and the metrics. The traces are for the investigation of one page view.

The datasources link the events and the traces:

- Loki: the derived field `Page view trace` reads the structured metadata `lag_page_view_trace_id` (a label matcher). In Explore, a `lag.page_view.start` event shows the link "Open the trace of the page view".
- Tempo: "Logs for this span" shows the lag events of the same page load (`service_instance_id`), from 1 minute before the span to 1 minute after it.

To find a trace without the dashboard, use this TraceQL query in Explore with the Tempo datasource:

```traceql
{ name = "lag.page_view" && resource.service.name = "shop" }
```

### Recording rules

The Mimir ruler loads `config/mimir/rules/anonymous/lag.yaml`. The directory name is the tenant. Without multitenancy, the tenant is `anonymous`.

| Rule | Expression |
|---|---|
| `service_name:<metric>:rate5m` | `sum by (service_name) (rate(<metric>[5m]))`, a native histogram |
| `service_name:<metric>:p95_rate5m` | The p95 of the same rate |
| `service_name:<metric>:p99_rate5m` | The p99 of the same rate |
| `service_name_navigation_type:<vital>:rate5m` | `sum by (service_name, navigation_type) (rate(<vital>[5m]))` |

The latency rules cover six histograms:

- `lag_drift_histogram`
- `lag_macrotask_histogram`
- `lag_worker_main_block_histogram`
- `lag_loaf_blocking_histogram`
- `lag_event_duration_histogram`
- `lag_frame_delta_histogram`

The vital rules cover the five `lag_web_vital_*_histogram` metrics.

Use the recorded series for long time ranges. To get a quantile of many services, sum the `rate5m` series first. Do not sum or average the recorded quantiles.

Mimir reads the rule file again every 10 minutes. To load a change at once, restart Mimir:

```sh
docker compose restart mimir
```

## Configure the OpenTelemetry SDK in a browser app

The dashboards need these settings in the browser app:

1. Use exponential histograms for all histogram instruments. Mimir then stores one native histogram series for each histogram.
2. Give each SDK instance its own `service.instance.id`. Use a new random UUID for each page load and for each worker.
3. Do not store the `service.instance.id`. Do not use the session ID as its value.
4. Use cumulative temporality. It is the default of the SDK. Mimir rejects delta metrics.
5. Export the metrics every 15 seconds.
6. Flush the providers when the page becomes hidden and on `pagehide`. Then the last values of a page arrive.
7. Put `session.id` on log records and spans. Do not put it on the resource.
8. Send each event as a log record with an event name.

This example uses the OpenTelemetry JS SDK 2.x:

```ts
import { AggregationType, InstrumentType, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { AggregationTemporalityPreference, OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";

const resource = resourceFromAttributes({
    "service.name": "shop",
    "service.version": "1.5.0",
    // A new value for each page load and for each worker
    "service.instance.id": crypto.randomUUID(),
});

const exporter = new OTLPMetricExporter({
    url: "http://localhost:4318/v1/metrics",
    temporalityPreference: AggregationTemporalityPreference.CUMULATIVE,
    // Exponential histograms for all histogram instruments
    aggregationPreference: (type) => type === InstrumentType.HISTOGRAM
        ? { type: AggregationType.EXPONENTIAL_HISTOGRAM }
        : { type: AggregationType.DEFAULT },
});

const meterProvider = new MeterProvider({
    resource,
    readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 15_000 })],
});

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void meterProvider.forceFlush();
});
addEventListener("pagehide", () => void meterProvider.forceFlush());
```

Use the same `resource` for the `LoggerProvider`. Send an event with `logger.emit({ eventName, attributes })`, and put `session.id` in `attributes`.

With otel-ts, set `histogramAggregation: "exponential"`. otel-ts sets the other items.

For the traces of the page views, give the lag monitors a span sink:

```ts
import * as api from "@opentelemetry/api";
import { createOtelSpanSink } from "@lag/core";

const spans = createOtelSpanSink(api.trace.getTracer("@lag/core"), api);
```

Use the same `resource` for the `TracerProvider`, and send the spans with the OTLP/HTTP exporter to `/v1/traces`. Flush the tracer provider when the page becomes hidden: the span of a view ends at that time. otel-ts registers its tracer provider as the global provider, and it flushes it.

## The Lag Monitor dashboard

`scripts/build-dashboards.mjs` generates `config/grafana/provisioning/dashboards/lag-monitor.json`. Do not edit the JSON file. Edit the script, then start it:

```sh
pnpm dashboards
```

Grafana reads the file again in 30 seconds or less.

The dashboard has these variables:

- Service: the `service_name` label.
- Page load: one SDK instance, the `instance` label (`service.instance.id`). With one page load, each panel and each annotation layer shows only that page. The long-range row uses recording rules that sum all page loads, thus this variable does not apply there.
- Session: the start of a `session.id`. The Page loads table shows the page loads of the matching sessions. A click on a page load sets the Page load variable.
- Navigation type: the `navigation_type` label of the Web Vitals metrics.

### Annotation layers

Each kind of lag event is an annotation layer, with its own switch at the top of the dashboard. A layer shows a mark on each time series panel at the time of each event. The lag library gives each event the time of its occurrence (for an event with a duration, the start). Thus a mark is at the time of the metric values that it explains.

| Layer | Event | On by default |
|---|---|---|
| Hangs | `lag.main_thread.hang` | yes |
| Stalls | `lag.stall` | yes |
| Page views | `lag.page_view.start` | no |
| Lifecycle | `lag.lifecycle.transition` | no |
| Compute pressure | `lag.pressure.change` | no |
| Clock jumps | `lag.clock.jump` | no |
| Long animation frames | `lag.long_animation_frame` | no |
| Browser reports | `lag.browser_report` | no |

The layers with many events are off by default. With all page loads, the marks of all pages are on the panels. Select one page load first, then turn on the layers. Each layer follows the Service and Page load variables. Its query parses the line of the event with `logfmt`, thus the title and the text of a mark can use each attribute.

The dashboard has one row for each monitor family:

- drift and the drift baseline
- macrotask
- scheduling (microtask, macrotask, MessageChannel)
- worker heartbeat: the delivery delay, the worker self-lag and the clock offset
- hangs, and the measurement conditions (stalls and discarded samples)
- clock (jumps, skew and resolution)
- long animation frames
- event timing and layout shift
- Web Vitals, with the good and poor thresholds
- frames, idle time, memory and compute pressure
- GC, page lifecycle and timer throttling
- browser reports and shared-memory liveness

Loki panels show the events: the page loads and their sessions, recent page views and lifecycle transitions, recent hangs and stalls, clock jumps, browser reports, LoAF attribution and Web Vitals values. The last row uses the recording rules.

### The Trace link

The table "Recent page views and lifecycle transitions" has a Trace column: the `lag_page_view_trace_id` of each `lag.page_view.start` event. A click on a trace ID opens the trace of the page view in Explore, with the Tempo datasource. The link is an internal data link to the datasource `tempo`. Grafana makes the URL of Explore from the trace ID. A lifecycle transition has no trace ID, and a view whose span was not sampled has no trace ID.

The trace shows the view as a timeline: the span of the view, and its hangs, stalls, long animation frames and hidden or frozen periods.

The row "Page view traces (Tempo)" has a TraceQL search: the traces of the page views in the time range, with their start and duration. It follows the Service and Page load variables. A click on a trace ID opens the trace.

The queries obey these rules:

- A histogram query first sums the rates of all page loads, then takes the quantile.
- An example is `histogram_quantile(0.95, sum(rate(x[$__rate_interval])))`.
- A counter query uses `rate()`.
- No query groups by `instance` or by session. A query can filter by one `instance` (the Page load variable).

The Mimir datasource sets `timeInterval` to `15s`, the export interval. Then `$__rate_interval` is 60 seconds or more.

## Send sample data and verify the pipeline

1. Install the script dependencies:

   ```sh
   pnpm install
   ```

2. Start the stack.
3. Send sample data for 3 minutes:

   ```sh
   pnpm sample-data --summary sample-summary.json
   ```

4. Verify the pipeline:

   ```sh
   pnpm verify --summary sample-summary.json
   ```

`scripts/send-sample-data.mjs` uses the OpenTelemetry JS SDK in the same way as a browser. It simulates six page loads of two services. Each page load has its own `service.instance.id`. The script records each metric of the lag catalog and sends each lag event. It also posts hang reports in the JSON shape of the lag worker, with `fetch` and `keepalive`.

The script also sends the spans, as `createOtelSpanSink` sends them: one trace for each page view, with the hangs, stalls, long animation frames and hidden and frozen periods of the view in it. It also sends the trace of an earlier page that hung and closed during its hang. Only the trace of that page is in the sample, not its metrics or events. A sample page reports the abandoned hang from the hang journal: the span of the hang is in the trace of the page that hung, with a link to the view of the sample page.

`scripts/verify-pipeline.mjs` checks these items:

- Alloy, Mimir, Loki, Tempo and Grafana are ready.
- The receiver answers the CORS preflight of localhost pages. It does not answer it for other origins.
- Mimir stores each catalog metric under its catalog name, and each histogram as a native histogram.
- The `instance` label is the `service.instance.id`. No series has a `session_id` label.
- The recording rules are healthy and have data.
- Loki has only the index labels `service_name` and `event_name`, and it has all the lag events.
- Tempo has one trace for each page view of the sample. The root span `lag.page_view` has the ID of the view, and each other span of the trace has the root as its parent. The spans have the attributes of the span catalog.
- The abandoned hang is in the trace of the page that hung, and it has a link to the view that reported it.
- The `lag.page_view.start` events have the trace ID and the span ID of their view.
- Grafana loads the dashboard, and each panel query and each annotation layer gives data.
- Grafana reads the traces from Tempo. The Loki derived field and the Trace column link to Tempo.

`scripts/screenshot-dashboard.mjs` takes screenshots after the sample data:

- `fleet.png`: the dashboard for all page loads.
- `page-<index>.png`: one page load, with every annotation layer on.
- `table-<title>.png`: each table of events, and the table of the page view traces.
- `trace-page-1.png`: the trace of the first view of page load 1. The script opens it with the Trace link of the page views table.
- `trace-abandoned-hang.png`: the trace of the page that hung, with the span of the abandoned hang and its references (the parent and the link).
- `explore-loki-trace-link.png`: a `lag.page_view.start` event in Explore, with the link to its trace.

The CI workflow `.github/workflows/verify.yml` does all of this on each pull request: it starts the stack, sends the sample data, verifies the pipeline and uploads the screenshots as the artifact `dashboard-screenshots`.

If Grafana uses a different port, add `--grafana http://localhost:3300`. To compare `scripts/lib/lag-catalog.mjs` with the lag catalog (metrics, events and spans), add `--catalog ../lag/packages/lag/src/metric-catalog.ts`.

## Troubleshooting

- The histogram panels show no data: the app sends explicit-bucket histograms. Mimir stores them as `_bucket`, `_sum` and `_count` series, and the dashboard does not use them. Configure exponential histograms.
- The series have no `instance` label: the app does not set `service.instance.id`. Then many page loads write to the same series, and `rate()` gives wrong values.
- Mimir rejects samples: look at `cortex_discarded_samples_total` at <http://localhost:9009/metrics>.
- The browser shows a CORS error: add the page origin to `allowed_origins` in `config/alloy/config.alloy`. Then restart Alloy.
- A panel shows the error "too many outstanding requests": increase `max_outstanding_requests_per_tenant` in `config/mimir/mimir.yaml`.
- The Trace column is empty: the app gives no span sink to the lag monitors, or the sampler did not sample the span of the view. Without a sampled span, the `lag.page_view.start` event has no trace ID.
- The trace of a view has no root span: the page closed before the span of the view ended, or before the exporter sent it. Flush the tracer provider when the page becomes hidden.
