# Roadmap

This file is the plan of grafana-infra. The Status page of the site reads it.

| ID | Item | Status | Summary |
| --- | --- | --- | --- |
| stack | Compose stack | done | Alloy, Mimir, Loki, Tempo, Pyroscope and Grafana start with one `docker compose up -d`. |
| lag-rules | Lag recording rules | done | `lag.yaml` holds the rate and quantile rules of the lag and Web Vitals histograms. |
| dashboards | Provisioned dashboards | done | Grafana loads the Lag Monitor and Frontend Observability dashboards at start. |
| sample-data | Sample data and pipeline check | done | `pnpm sample-data` sends telemetry, and `pnpm verify` reads it back from each backend. |
| site | Project site | done | The site reads the real files, and it shows the route of each signal and the links between panels and rules. |
| profiles-route | A route for profiles | not started | Alloy has no output for profiles today, so Pyroscope has no data from the browser. |
| pin-pyroscope | A pinned Pyroscope image | not started | `docker-compose.yml` uses `grafana/pyroscope:latest`, so a new start can get a different version. |
| log-stream-panel | The Log Stream query | not started | The panel reads the label `exporter`, and `loki.yaml` indexes only `service_name` and `event_name`. |
