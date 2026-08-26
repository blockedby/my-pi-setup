export type IncrementalReducerStatus = "idle" | "busy" | "finalized";

export interface IncrementalFanInSnapshot<Contributor extends string> {
  readonly expectedContributors: ReadonlyArray<Contributor>;
  readonly acceptedContributors: ReadonlyArray<Contributor>;
  readonly pendingContributors: ReadonlyArray<Contributor>;
  readonly integratedContributors: ReadonlyArray<Contributor>;
  readonly reducerStatus: IncrementalReducerStatus;
  readonly revision: number;
  readonly finalReportValidated: boolean;
}

export interface IncrementalReducerTurn<Contributor extends string, Report> {
  readonly revision: number;
  readonly contributors: ReadonlyArray<Contributor>;
  readonly reports: ReadonlyArray<Report>;
  readonly final: boolean;
}

interface IncrementalFanInOptions<
  Contributor extends string,
  Report,
  Intermediate,
  Final,
> {
  readonly expectedContributors: ReadonlyArray<Contributor>;
  readonly validateReport: (contributor: Contributor, value: unknown) => Report;
  readonly validateIntermediate: (
    value: unknown,
    integratedContributors: ReadonlyArray<Contributor>,
  ) => Intermediate;
  readonly validateFinal: (
    value: unknown,
    integratedContributors: ReadonlyArray<Contributor>,
  ) => Final;
}

/**
 * A model-agnostic, bounded incremental fan-in state machine. It accepts each
 * declared contributor once, serializes reducer turns, batches arrivals while
 * a turn is busy, and validates the only report allowed to finalize the fan-in.
 */
export class IncrementalFanInReducer<
  Contributor extends string,
  Report,
  Intermediate,
  Final,
> {
  private readonly expected: ReadonlyArray<Contributor>;
  private readonly expectedSet: ReadonlySet<Contributor>;
  private readonly accepted = new Map<Contributor, Report>();
  private readonly pending: Contributor[] = [];
  private readonly integrated = new Set<Contributor>();
  private inFlight?: IncrementalReducerTurn<Contributor, Report>;
  private intermediate?: Intermediate;
  private final?: Final;
  private revision = 0;
  private readonly options: IncrementalFanInOptions<
    Contributor,
    Report,
    Intermediate,
    Final
  >;

  constructor(
    options: IncrementalFanInOptions<Contributor, Report, Intermediate, Final>,
  ) {
    this.options = options;
    if (options.expectedContributors.length === 0) {
      throw new Error("Incremental fan-in requires at least one contributor.");
    }
    if (
      new Set(options.expectedContributors).size !==
      options.expectedContributors.length
    ) {
      throw new Error("Incremental fan-in contributors must be unique.");
    }
    this.expected = [...options.expectedContributors];
    this.expectedSet = new Set(options.expectedContributors);
  }

  accept(contributor: Contributor, value: unknown) {
    if (!this.expectedSet.has(contributor)) {
      throw new Error(
        `Unexpected incremental fan-in contributor: ${contributor}.`,
      );
    }
    if (this.accepted.has(contributor)) return false;
    if (this.final) {
      throw new Error(
        "Cannot accept a contributor after reducer finalization.",
      );
    }
    const report = this.options.validateReport(contributor, value);
    this.accepted.set(contributor, report);
    this.pending.push(contributor);
    return true;
  }

  nextTurn(): IncrementalReducerTurn<Contributor, Report> | undefined {
    if (this.inFlight || this.final || this.pending.length === 0)
      return undefined;
    const contributors = this.pending.splice(0);
    const reports = contributors.map((contributor) =>
      this.accepted.get(contributor)!,
    );
    const integratedAfterTurn = new Set([...this.integrated, ...contributors]);
    const turn = {
      revision: ++this.revision,
      contributors,
      reports,
      final: this.expected.every((contributor) =>
        integratedAfterTurn.has(contributor),
      ),
    } satisfies IncrementalReducerTurn<Contributor, Report>;
    this.inFlight = turn;
    return turn;
  }

  settle(value: unknown) {
    const turn = this.inFlight;
    if (!turn) throw new Error("The incremental reducer has no active turn.");
    const integratedAfterTurn = this.expected.filter(
      (contributor) =>
        this.integrated.has(contributor) ||
        turn.contributors.includes(contributor),
    );
    if (turn.final) {
      this.final = this.options.validateFinal(value, integratedAfterTurn);
    } else {
      this.intermediate = this.options.validateIntermediate(
        value,
        integratedAfterTurn,
      );
    }
    for (const contributor of turn.contributors)
      this.integrated.add(contributor);
    this.inFlight = undefined;
    return turn.final ? this.final : this.intermediate;
  }

  get activeTurn() {
    return this.inFlight;
  }

  get finalReport() {
    return this.final;
  }

  snapshot(): IncrementalFanInSnapshot<Contributor> {
    return {
      expectedContributors: [...this.expected],
      acceptedContributors: this.expected.filter((item) =>
        this.accepted.has(item),
      ),
      pendingContributors: [...this.pending],
      integratedContributors: this.expected.filter((item) =>
        this.integrated.has(item),
      ),
      reducerStatus: this.final ? "finalized" : this.inFlight ? "busy" : "idle",
      revision: this.revision,
      finalReportValidated: Boolean(this.final),
    };
  }
}
