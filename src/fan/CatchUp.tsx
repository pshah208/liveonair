import { useEffect, useId, useRef, useState } from "react";
import { buildCatchUp, type CatchUp, type CatchUpInput } from "../../shared/fan.js";
import { FAN_TEXT } from "./strings.js";

type CatchUpProps = Omit<CatchUpInput, "currentSecond"> & { currentSecond: number };

/** One-tap "Catch up": a three-line recap and the three biggest moments up to the current minute. No model call. */
export function CatchUpCard({ fixture, storylines, currentSecond, language }: CatchUpProps) {
  const [catchUp, setCatchUp] = useState<CatchUp | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const currentMinute = Math.floor(Math.max(0, currentSecond) / 60);
  const build = () => setCatchUp(buildCatchUp({ fixture, storylines, currentSecond, language }));
  const opened = catchUp !== null;

  useEffect(() => {
    if (opened) headingRef.current?.focus();
  }, [opened]);

  return (
    <section className="fan-p2-catchup" aria-label="Catch up">
      {!opened ? (
        <button ref={triggerRef} type="button" className="button button--primary fan-p2-catchup__button" aria-expanded={false} aria-controls={panelId} onClick={build}>
          {FAN_TEXT.catchUp(currentMinute)}
        </button>
      ) : (
        <div id={panelId} className="fan-p2-catchup__panel">
          <h2 ref={headingRef} tabIndex={-1} className="fan-p2-section__title">{FAN_TEXT.catchUpTitle(catchUp.minute)}</h2>
          <ul className="fan-p2-catchup__lines">
            {catchUp.lines.map((line, index) => <li key={index}>{line}</li>)}
          </ul>
          <h3 className="fan-p2-catchup__subtitle">{FAN_TEXT.catchUpMoments}</h3>
          {catchUp.moments.length === 0 ? <p className="fan-p2-empty">{FAN_TEXT.catchUpNoMoments}</p> : (
            <ol className="fan-p2-catchup__moments">
              {catchUp.moments.map((moment) => (
                <li key={moment.key}>
                  <span className="mono fan-p2-catchup__minute">{moment.minute}′</span>
                  <span className={`fan-p2-pill${moment.source === "approved" ? " fan-p2-pill--approved" : ""}`}>{moment.source === "approved" ? FAN_TEXT.sourceApproved : FAN_TEXT.sourceFeed}</span>
                  <span className="fan-p2-catchup__text"><strong>{moment.title}</strong>{moment.detail && moment.detail !== moment.title ? <span>{moment.detail}</span> : null}</span>
                </li>
              ))}
            </ol>
          )}
          <p className="fan-p2-note">{FAN_TEXT.catchUpNote(catchUp.minute)}</p>
          <div className="fan-p2-catchup__actions">
            {currentMinute > catchUp.minute && <button type="button" className="button button--ghost button--small" onClick={build}>{FAN_TEXT.catchUpRefresh(currentMinute)}</button>}
            <button type="button" className="button button--ghost button--small" aria-controls={panelId} aria-expanded={true} onClick={() => {
              setCatchUp(null);
              requestAnimationFrame(() => triggerRef.current?.focus());
            }}>{FAN_TEXT.close}</button>
          </div>
        </div>
      )}
    </section>
  );
}
