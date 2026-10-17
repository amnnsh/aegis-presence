
"use client";

import * as React from "react";

import {
  adminSession,
  adminSessions,
  adminStreamUrl,
  adminSummary,
  analyzeSessionWithGemini,
  createLink,
  toDecisionResult,
} from "../lib/api.ts";

import type {
  AdminSession,
  AdminSessionDetail,
  AdminSummary,
  GeminiAnalysisResponse,
  HelpDeskLink,
} from "../lib/api.ts";

import { DecisionBadge, Icon, ResultView } from "./ui.tsx";

/**
 * Live verification sessions from the FastAPI backend.
 *
 * Security:
 * - Admin token stays in component memory.
 * - No credentials are stored in localStorage.
 * - Gemini analysis is advisory only.
 * - Gemini cannot modify verification decisions.
 * - Reports are associated with their original session.
 */

export function LiveActivity() {
  const [token, setToken] = React.useState("");
  const [connected, setConnected] = React.useState(false);
  const [streaming, setStreaming] = React.useState(false);
  const [error, setError] = React.useState("");

  const [sessions, setSessions] = React.useState<
    AdminSession[]
  >([]);

  const [summary, setSummary] =
    React.useState<AdminSummary | null>(null);

  const [detail, setDetail] =
    React.useState<AdminSessionDetail | null>(null);

  const [label, setLabel] = React.useState("");
  const [link, setLink] =
    React.useState<HelpDeskLink | null>(null);

  // Gemini Security Analyst state.
  const [geminiReport, setGeminiReport] =
    React.useState<GeminiAnalysisResponse | null>(null);

  const [geminiLoading, setGeminiLoading] =
    React.useState(false);

  const [geminiError, setGeminiError] =
    React.useState("");

  // Prevent stale responses from previous sessions.
  const requestVersion = React.useRef(0);

  // Prevent late admin-session responses after disconnect.
  const sessionRequestVersion = React.useRef(0);

  const connect = () => {
    setError("");

    Promise.all([
      adminSessions(token),
      adminSummary(token),
    ])
      .then(([list, counts]) => {
        setSessions(list.sessions);
        setSummary(counts);
        setConnected(true);
      })
      .catch((e) => {
        setConnected(false);
        setError(
          e instanceof Error
            ? e.message
            : "Could not load sessions."
        );
      });
  };

  // Subscribe to live backend session events.
  React.useEffect(() => {
    if (!connected) return;

    const source = new EventSource(
      adminStreamUrl(token)
    );

    source.onopen = () => {
      setStreaming(true);
    };

    source.onerror = () => {
      setStreaming(false);
    };

    source.onmessage = (message) => {
      try {
        const update = JSON.parse(message.data) as {
          type: string;
          session: AdminSession;
        };

        if (!update.session?.id) return;

        setSessions((rows) =>
          [
            update.session,
            ...rows.filter(
              (row) => row.id !== update.session.id
            ),
          ]
            .sort((a, b) =>
              b.created_at.localeCompare(a.created_at)
            )
            .slice(0, 100)
        );

        if (update.type !== "session.status") {
          adminSummary(token)
            .then(setSummary)
            .catch(() => undefined);
        }
      } catch {
        // Ignore malformed streaming events.
      }
    };

    return () => {
      source.close();
      setStreaming(false);
    };
  }, [connected, token]);

  const resetGemini = () => {
    requestVersion.current += 1;
    setGeminiReport(null);
    setGeminiLoading(false);
    setGeminiError("");
  };

  const inspect = (id: string) => {
    const version = ++sessionRequestVersion.current;

    resetGemini();
    setError("");

    if (detail?.id === id) {
      setDetail(null);
      return;
    }

    setDetail(null);

    adminSession(token, id)
      .then((session) => {
        if (
          version !== sessionRequestVersion.current
        ) {
          return;
        }

        setDetail(session);
      })
      .catch((e) => {
        if (
          version !== sessionRequestVersion.current
        ) {
          return;
        }

        setError(
          e instanceof Error
            ? e.message
            : "Could not load the session."
        );
      });
  };

  const makeLink = () => {
    createLink(token, label.trim())
      .then((created) => {
        setLink(created);
        setLabel("");
      })
      .catch((e) => {
        setError(
          e instanceof Error
            ? e.message
            : "Could not create a link."
        );
      });
  };

  const disconnect = () => {
    sessionRequestVersion.current += 1;
    resetGemini();

    setConnected(false);
    setStreaming(false);
    setToken("");
    setSessions([]);
    setSummary(null);
    setDetail(null);
    setLink(null);
    setError("");
  };

  // Request Gemini analysis for a completed session.
  const analyzeWithGemini = async () => {
    if (
      !connected ||
      !detail ||
      detail.status !== "completed" ||
      geminiLoading
    ) {
      return;
    }

    const sessionId = detail.id;
    const version = ++requestVersion.current;

    setGeminiLoading(true);
    setGeminiError("");
    setGeminiReport(null);

    try {
      const report = await analyzeSessionWithGemini(
        token,
        sessionId
      );

      // Ignore a response if the operator changed sessions
      // or disconnected while Gemini was processing.
      if (version !== requestVersion.current) {
        return;
      }

      if (report.session_id !== sessionId) {
        setGeminiError(
          "The Gemini report did not match the selected session."
        );
        return;
      }

      setGeminiReport(report);
    } catch (e) {
      if (version !== requestVersion.current) {
        return;
      }

      setGeminiError(
        e instanceof Error
          ? e.message
          : "Gemini analysis is unavailable."
      );
    } finally {
      if (version === requestVersion.current) {
        setGeminiLoading(false);
      }
    }
  };

  const result = detail?.result
    ? toDecisionResult({
        ...detail.result,
        session_id: detail.id,
        policy_version:
          detail.policy_version ?? "",
        token: "",
      })
    : null;

  const time = (value: string) =>
    new Date(value)
      .toISOString()
      .slice(11, 19);

  return (
    <section
      className="panel live-panel"
      aria-label="Live server sessions"
    >
      <div className="attempts-heading">
        <div>
          <h2>Live sessions</h2>
          <span className="microcopy">
            From the verification server &middot;
            outcomes and event timing only, never media
            &middot; UTC
          </span>
        </div>

        <span className="dataset-badge">
          <span
            className={`dot ${
              streaming ? "" : "dot-amber"
            }`}
          />
          {connected
            ? streaming
              ? "LIVE STREAM"
              : "RECONNECTING"
            : "NOT CONNECTED"}
        </span>
      </div>

      {!connected ? (
        <div className="live-connect">
          <label className="search-box">
            <Icon name="lock" size={16} />
            <span className="sr-only">
              Admin token
            </span>

            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(e) =>
                setToken(e.target.value)
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" && token) {
                  connect();
                }
              }}
              placeholder="Admin token"
            />
          </label>

          <button
            className="button button-secondary"
            disabled={!token}
            onClick={connect}
          >
            Connect
          </button>

          <p className="microcopy">
            The token stays in this tab&apos;s
            memory and is sent only to the
            verification server. It is never
            part of the site bundle.
          </p>
        </div>
      ) : (
        <>
          <div className="live-connect">
            <label className="search-box">
              <Icon name="globe" size={16} />

              <span className="sr-only">
                Help-desk link label
              </span>

              <input
                value={label}
                maxLength={64}
                onChange={(e) =>
                  setLabel(e.target.value)
                }
                placeholder="Help-desk link label"
              />
            </label>

            <button
              className="button button-secondary"
              disabled={!label.trim()}
              onClick={makeLink}
            >
              Create single-use link
            </button>

            <button
              className="button button-text"
              onClick={disconnect}
            >
              Disconnect
            </button>
          </div>

          {link && (
            <p className="live-link microcopy">
              Single-use, expires{" "}
              {time(link.expires_at)} UTC:{" "}
              <code className="mono token-box">
                {link.verify_url}
              </code>
            </p>
          )}

          {summary && (
            <p className="microcopy live-summary">
              {summary.total} session(s) in
              retention.{" "}
              {summary.by_presenter_decision
                .map(
                  (row) =>
                    `${
                      row.presenter_label ??
                      "unlabeled"
                    } / ${
                      row.decision ??
                      "no decision"
                    }: ${row.count}`
                )
                .join(" · ")}
            </p>
          )}

          <div className="table-scroll">
            <table className="attempt-table">
              <thead>
                <tr>
                  <th>Session / created</th>
                  <th>Label</th>
                  <th>Status</th>
                  <th>Risk index</th>
                  <th>Decision</th>
                  <th>
                    <span className="sr-only">
                      Inspect
                    </span>
                  </th>
                </tr>
              </thead>

              <tbody>
                {sessions.map((row) => (
                  <tr
                    key={row.id}
                    className={
                      row.id === detail?.id
                        ? "row-selected"
                        : ""
                    }
                  >
                    <td>
                      <strong className="mono">
                        {row.id.slice(0, 8)}
                      </strong>

                      <span className="table-time">
                        {time(row.created_at)}
                      </span>
                    </td>

                    <td>
                      {row.presenter_label ??
                        row.link_label ??
                        "-"}

                      <span className="table-time">
                        {row.ua_family ?? ""}
                      </span>
                    </td>

                    <td>{row.status}</td>

                    <td>
                      {row.risk === null ? (
                        "-"
                      ) : (
                        <span className="mono">
                          {row.risk}
                          <small>/100</small>
                        </span>
                      )}
                    </td>

                    <td>
                      {row.decision ? (
                        <DecisionBadge
                          decision={row.decision}
                        />
                      ) : (
                        "-"
                      )}
                    </td>

                    <td>
                      <button
                        className="icon-button"
                        aria-label={`Inspect session ${row.id.slice(
                          0,
                          8
                        )}`}
                        onClick={() =>
                          inspect(row.id)
                        }
                      >
                        <Icon
                          name="chevron"
                          size={17}
                        />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {sessions.length === 0 && (
            <p className="microcopy live-summary">
              No sessions yet. Start one from
              Verification; it appears here
              as it happens.
            </p>
          )}

          {detail && (
            <div className="live-detail">
              <p className="microcopy">
                <span className="mono">
                  {detail.id}
                </span>
                {" · "}
                {detail.status}
                {" · "}
                {detail.events.length}
                {" timing event(s) stored"}

                {detail.events.length > 0 &&
                  `: ${detail.events
                    .map((e) => e.type)
                    .join(", ")}`}
              </p>

              {result ? (
                <ResultView
                  result={result}
                  sessionLabel={detail.id.slice(
                    0,
                    8
                  )}
                  compact
                />
              ) : (
                <p className="microcopy">
                  No decision recorded for
                  this session.
                </p>
              )}

              {/* Gemini Security Analyst */}
              {detail.status === "completed" && (
                <div
                  className="gemini-analyst"
                  style={{ marginTop: 24 }}
                >
                  <div className="attempts-heading">
                    <div>
                      <h3>
                        Gemini AI Security Analyst
                      </h3>

                      <p className="microcopy">
                        AI-assisted interpretation
                        of verification evidence.
                        Advisory only.
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={analyzeWithGemini}
                    disabled={geminiLoading}
                  >
                    {geminiLoading
                      ? "Analyzing with Gemini..."
                      : "Analyze with Gemini"}
                  </button>

                  {geminiLoading && (
                    <p
                      className="microcopy"
                      role="status"
                    >
                      Gemini is preparing the
                      security review. This may
                      take several seconds.
                    </p>
                  )}

                  {geminiError && (
                    <div
                      className="notice notice-amber"
                      role="alert"
                    >
                      <Icon
                        name="info"
                        size={18}
                      />
                      <p>{geminiError}</p>
                    </div>
                  )}

                  {geminiReport &&
                    geminiReport.session_id ===
                      detail.id && (
                      <div
                        className="gemini-report"
                        style={{
                          marginTop: 20,
                        }}
                      >
                        <h4>
                          AI Security Summary
                        </h4>

                        <p>
                          {
                            geminiReport.analyst
                              .summary
                          }
                        </p>

                        <p className="microcopy">
                          Policy decision:{" "}
                          {
                            geminiReport
                              .policy_decision
                          }
                          {" · "}
                          Risk index:{" "}
                          {
                            geminiReport
                              .policy_risk
                          }
                          /100
                        </p>

                        <h4>
                          Evidence Findings
                        </h4>

                        {geminiReport.analyst
                          .findings.length === 0 ? (
                          <p className="microcopy">
                            No specific findings
                            were generated.
                          </p>
                        ) : (
                          <ul>
                            {geminiReport.analyst.findings.map(
                              (
                                finding,
                                index
                              ) => (
                                <li
                                  key={`${finding.signal_id}-${index}`}
                                >
                                  <strong>
                                    {
                                      finding.signal_id
                                    }
                                    {" — "}
                                    {
                                      finding.concern
                                    }
                                  </strong>

                                  <p>
                                    {
                                      finding.observation
                                    }
                                  </p>

                                  <p className="microcopy">
                                    {
                                      finding.explanation
                                    }
                                  </p>
                                </li>
                              )
                            )}
                          </ul>
                        )}

                        <h4>
                          Missing Evidence
                        </h4>

                        {geminiReport.analyst
                          .missing_evidence.length ===
                        0 ? (
                          <p className="microcopy">
                            No missing evidence
                            was listed.
                          </p>
                        ) : (
                          <ul>
                            {geminiReport.analyst.missing_evidence.map(
                              (
                                item,
                                index
                              ) => (
                                <li key={index}>
                                  {item}
                                </li>
                              )
                            )}
                          </ul>
                        )}

                        <h4>
                          Recommended Next Steps
                        </h4>

                        <ul>
                          {geminiReport.analyst.recommended_next_steps.map(
                            (step, index) => (
                              <li key={index}>
                                {step}
                              </li>
                            )
                          )}
                        </ul>

                        <h4>
                          Limitations
                        </h4>

                        <p>
                          {
                            geminiReport.analyst
                              .limitations
                          }
                        </p>

                        <p className="microcopy">
                          Report completeness
                          confidence:{" "}
                          {
                            geminiReport.analyst
                              .confidence
                          }
                        </p>

                        <div className="notice notice-amber">
                          <Icon
                            name="info"
                            size={18}
                          />

                          <p>
                            Gemini provides
                            advisory explanations
                            only. It does not
                            authenticate users,
                            prove fraud, or
                            override the
                            verification policy.
                          </p>
                        </div>
                      </div>
                    )}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {error && (
        <div
          className="notice notice-amber"
          role="alert"
        >
          <Icon name="info" size={18} />
          <p>{error}</p>
        </div>
      )}
    </section>
  );
}
