/** The data that the build reads from the real files of the stack. The page gets it as one JSON value. */

/** The signals of the map. */
export const SIGNALS = ["metrics", "logs", "traces", "profiles"] as const;

/** A signal of the map. */
export type Signal = (typeof SIGNALS)[number];

/** A range of lines of a file of the repository, from 1. */
export interface Source {
  readonly file: string;
  readonly start: number;
  readonly end: number;
  /** What the lines define. */
  readonly label: string;
}

/** A node of the map. */
export interface MapNode {
  readonly id: string;
  readonly title: string;
  /** The real name of the node: a component, a service or a data source. */
  readonly name: string;
  /** The real value of the node, for example an endpoint. It can use the `${VAR}` forms of the Compose file. */
  readonly detail: string;
  /** The column of the map, from 0. */
  readonly column: number;
  /** The row of the map, from 0. The value can have a fraction. */
  readonly row: number;
  readonly sources: readonly Source[];
}

/** A hop of the map. */
export interface MapEdge {
  readonly from: string;
  readonly to: string;
  /** The signals that take this hop. */
  readonly signals: readonly Signal[];
  /** A real value of the hop, for example the endpoint. */
  readonly label: string;
  /** True for a hop of a second route: for example the span metrics that a connector of Alloy makes from the traces. */
  readonly branch: boolean;
}

/** A second route of a signal: a connector of Alloy gives another signal, which goes to another backend. */
export interface Branch {
  /** The node that the second route leaves from. */
  readonly from: string;
  /** The nodes of the second route, in order, from the connector to Grafana. */
  readonly nodes: readonly string[];
  /** What the second route carries, for example "Span metrics". */
  readonly label: string;
}

/** The route of one signal. */
export interface Route {
  readonly signal: Signal;
  /** The nodes of the main route, in order. */
  readonly nodes: readonly string[];
  /** The second routes, one for each connector on the main route. */
  readonly branches: readonly Branch[];
  /** The UID of the data source of Grafana. */
  readonly datasource: string;
  /** The reason when the route does not go through Alloy. */
  readonly gap: { readonly text: string; readonly source: Source } | null;
}

/** A variable of the editor. */
export interface StackVariable {
  readonly name: string;
  /** The value in `.env`, or `null` when the file has no value. The value of a hidden variable is always `null`. */
  readonly env: string | null;
  /** The default in the Compose file. The default of a hidden variable is always `null`. */
  readonly composeDefault: string | null;
  readonly hidden: boolean;
  /** The lines of the Compose file that use the variable. */
  readonly lines: readonly number[];
  /** The line of `.env`, when the file has the variable. */
  readonly envLine: number | null;
  /** The comment above the variable in `.env`, or `Compose only`. */
  readonly group: string;
}

/** A recording rule of `lag.yaml`. */
export interface Rule {
  readonly record: string;
  readonly expr: string;
  readonly group: string;
  readonly interval: string;
  readonly source: Source;
  /** The series that the expression reads. */
  readonly inputs: readonly string[];
  /** The metric of the name `level:metric:operation`. */
  readonly metric: string;
  /** The operation of the name `level:metric:operation`. */
  readonly operation: string;
}

/** A query of a panel. */
export interface PanelTarget {
  readonly refId: string;
  readonly query: string;
  /** The UID of the data source, after the rules of Grafana for an empty or a missing value. */
  readonly datasource: string;
  readonly series: readonly string[];
}

/** A panel of a dashboard. */
export interface Panel {
  readonly id: number;
  readonly type: string;
  readonly title: string;
  readonly description: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly targets: readonly PanelTarget[];
  /** The UIDs of the data sources of the targets. */
  readonly datasources: readonly string[];
  /** The rules that a query of the panel names. */
  readonly rules: readonly string[];
  /** The rules that read a series of this panel. No query of the panel names them. */
  readonly sharedRules: readonly string[];
}

/** A dashboard. */
export interface Dashboard {
  readonly uid: string;
  readonly title: string;
  readonly file: string;
  /** The height of the dashboard in grid rows. */
  readonly rows: number;
  readonly panels: readonly Panel[];
}

/** A data source of Grafana. */
export interface DataSource {
  readonly uid: string;
  readonly name: string;
  readonly type: string;
  readonly url: string;
  readonly isDefault: boolean;
  /** The number of panel queries that read it. */
  readonly queries: number;
  readonly source: Source;
}

/** A file that the page can show. */
export interface FileText {
  readonly path: string;
  readonly lines: readonly string[];
}

/** All the data of the page. */
export interface Snapshot {
  readonly files: readonly FileText[];
  readonly nodes: readonly MapNode[];
  readonly edges: readonly MapEdge[];
  readonly routes: readonly Route[];
  readonly variables: readonly StackVariable[];
  readonly datasources: readonly DataSource[];
  readonly rules: readonly Rule[];
  readonly dashboards: readonly Dashboard[];
  /** The lines of `config.alloy` that make the span metrics from the traces. */
  readonly spanMetrics: Source;
  /** The number of Compose services. */
  readonly services: number;
}
