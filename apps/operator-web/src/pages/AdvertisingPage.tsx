/** @author masterzee001 */
/**
 * 07 Advertising.
 *
 * "USE PROGRAMME CREATIVE", NOT "ADVERTISING ENABLED". The sponsored slot is a
 * reserved first-class placement on every viewer surface; switching your own
 * creative off returns it to the house creative, it does not give anybody an
 * advert-free programme. Labelling the control the other way would be a promise
 * we do not keep, and the operator would only discover it by watching their own
 * stream.
 *
 * THE SERVICE OWNS EFFECTIVE STATE. Whether a creative is active, scheduled or
 * past its window is decided against the SERVICE clock and rendered here as
 * received. A browser evaluating the schedule itself would disagree with what
 * viewers are actually served whenever a machine's date was wrong -- and it
 * would be the console, the thing the operator trusts, that was lying.
 *
 * THE DESTINATION IS CHECKED ON THE SERVER. This form does not sanitise the
 * link; it shows what the server said about it. A client-side check would be
 * bypassable and, worse, would suggest the field is safe because the page
 * looked satisfied.
 *
 * AND THIS PAGE IS NOT THE WHOLE OF ADVERTISING. It manages the operator's own
 * sponsored creative -- their message, in their slot. C7 decides which
 * ADVERTS run in a programme, and an operator reading only the form below
 * would reasonably conclude the slot is entirely theirs. So the service's own
 * account of that is stated at the top, read-only, in the service's words.
 */
import React, { useEffect, useState } from 'react';
import type {
  EffectiveSponsoredCreative,
  ProgrammeSponsoredCreative,
  SponsoredEffectiveState,
} from '@videofy-live/shared-types';
import type { AdvertisingSnapshot, CreativeProblemDto } from '../advertisingClient';
import type { AdvertisingRuntimeView } from '../runtimeClient';
import type { AdvertisingConflict } from '../useAdvertising';
import styles from './AdvertisingPage.module.css';

export interface AdvertisingPageProps {
  /**
   * What the service says about C7's advertising, or null when the runtime
   * has not been read. Null renders as "not read", never as "none": one is an
   * absence of information and the other is a claim about the broadcast.
   */
  readonly c7: AdvertisingRuntimeView | null;
  readonly snapshot: AdvertisingSnapshot | null;
  readonly unavailable: boolean;
  readonly conflict: AdvertisingConflict | null;
  readonly problems: readonly CreativeProblemDto[];
  readonly saving: boolean;
  readonly loading: boolean;
  readonly onReload: () => void;
  readonly onSave: (
    creative: ProgrammeSponsoredCreative,
    expectedRevision: number,
  ) => void;
}

/**
 * What C7 decides, said before the form an operator can change.
 *
 * READ-ONLY BY CONSTRUCTION. There is no control here, and there is nothing to
 * add one to: a broadcaster who could choose their advertiser, skip one they
 * disliked, or read what a campaign pays would make the platform unsellable to
 * advertisers. The one thing they can contribute is knowledge C7 does not
 * have -- whether a moment would cut somebody off mid-sentence -- and that is
 * offered from Live Control, not here.
 */
function C7AdvertisingStatus({ c7 }: { readonly c7: AdvertisingRuntimeView | null }): React.ReactElement {
  return (
    <section className={styles.c7} aria-label="C7 advertising">
      <h3 className={styles.c7Title}>C7 advertising</h3>
      <p className={styles.c7Body}>
        Adverts in this programme are decided by C7. You cannot choose the
        advertiser, the campaign or the creative, and you are not shown which
        campaigns are running or what they pay. Your own sponsored message is
        the form below.
      </p>
      <p className={styles.c7Body}>
        {c7 === null
          ? 'The service has not been read yet, so what is attached is unknown.'
          : c7.campaignSource === 'none'
            ? 'No campaign source is attached to this deployment, so no advert will be decided.'
            : `A campaign source is attached, holding ${c7.campaignsHeld} campaign${c7.campaignsHeld === 1 ? '' : 's'} eligible for consideration.`}
      </p>
    </section>
  );
}

const STATE_LABEL: Record<SponsoredEffectiveState, string> = {
  'programme-active': 'PROGRAMME CREATIVE ACTIVE',
  scheduled: 'SCHEDULED',
  'programme-disabled': 'PROGRAMME CREATIVE DISABLED',
  'window-ended': 'WINDOW ENDED',
  'house-active': 'HOUSE CREATIVE ACTIVE',
};

const STATE_CLASS: Record<SponsoredEffectiveState, string | undefined> = {
  'programme-active': styles.active,
  scheduled: styles.scheduled,
  'programme-disabled': styles.disabled,
  'window-ended': styles.ended,
  'house-active': styles.house,
};

const BLANK: ProgrammeSponsoredCreative = {
  headline: '', body: '', cta: '', href: null,
  enabled: false, startsAt: null, endsAt: null,
};

/** An ISO instant as the value a datetime-local input wants, in local time. */
function toLocalInput(iso: string | null): string {
  if (iso === null) return '';
  const date = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Back to an instant. The SERVER canonicalises; this only has to be parseable. */
function fromLocalInput(value: string): string | null {
  if (value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function Effective({ effective }: { effective: EffectiveSponsoredCreative }): React.ReactElement {
  return (
    <div className={styles.effective} data-state={effective.state} data-source={effective.source}>
      <div className={styles.effectiveHead}>
        <span className={`${styles.badge} ${STATE_CLASS[effective.state] ?? ''}`}>
          {STATE_LABEL[effective.state]}
        </span>
        <span className={styles.sourceNote}>
          Viewers are being served the{' '}
          <strong>{effective.source === 'programme' ? 'programme' : 'house'}</strong> creative
        </span>
      </div>
      {/* The service's own sentence, not a second one composed here. */}
      <p className={styles.effectiveWhy}>{effective.explanation}</p>
    </div>
  );
}

export function AdvertisingPage(props: AdvertisingPageProps): React.ReactElement {
  const stored = props.snapshot?.creative ?? null;
  const [draft, setDraft] = useState<ProgrammeSponsoredCreative>(stored ?? BLANK);

  useEffect(() => {
    setDraft(props.snapshot?.creative ?? BLANK);
  }, [props.snapshot]);

  if (props.unavailable) {
    /*
     * NO DURABLE STORAGE. There is deliberately no form here: offering one
     * would invite an operator to type a creative that cannot be saved, and a
     * local "save" would be a lie viewers never see the other end of.
     */
    return (
      <div className={styles.page}>
        <C7AdvertisingStatus c7={props.c7} />
        <p className={styles.empty}>
          <strong>Your own sponsored creative cannot be configured on this deployment.</strong>{' '}
          Durable storage is not configured, so a creative could not be kept and
          would be lost on restart. Viewers continue to see the house creative,
          which needs no storage.
        </p>
        <button type="button" className={styles.secondary} onClick={props.onReload}>
          Try again
        </button>
      </div>
    );
  }

  if (props.snapshot === null) {
    return (
      <div className={styles.page}>
        <C7AdvertisingStatus c7={props.c7} />
        <p className={styles.empty}>
          {props.loading ? 'Reading advertising configuration…' : 'Not read yet.'}
        </p>
        <button type="button" className={styles.secondary} onClick={props.onReload}>
          Read advertising
        </button>
      </div>
    );
  }

  const revision = props.snapshot.revision;
  const set = <K extends keyof ProgrammeSponsoredCreative>(
    key: K, value: ProgrammeSponsoredCreative[K],
  ): void => setDraft((d) => ({ ...d, [key]: value }));

  const problemFor = (field: string): string | undefined =>
    props.problems.find((p) => p.field === field)?.message;

  return (
    <div className={styles.page}>
      <C7AdvertisingStatus c7={props.c7} />
      <div className={styles.header}>
        <p className={styles.revision}>Revision {revision}</p>
        <button type="button" className={styles.secondary} onClick={props.onReload}>
          {props.loading ? 'Reloading…' : `Reload revision ${revision}`}
        </button>
      </div>

      <Effective effective={props.snapshot.effective} />

      {props.conflict !== null ? (
        <p className={styles.conflict} role="alert">
          {/*
            * The exact words, and they stop the operator rather than offering a
            * retry: retrying with the server's revision is the silent overwrite
            * the gate exists to prevent.
            */}
          Advertising changed since you opened this page. Reload the latest
          revision before saving.
        </p>
      ) : null}

      <form
        className={styles.form}
        data-testid="advertising-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (props.saving) return;
          props.onSave(draft, revision);
        }}
      >
        <label className={styles.field}>
          <span>Headline</span>
          <input name="headline" value={draft.headline}
                 onChange={(e) => set('headline', e.target.value)} />
          {problemFor('headline') !== undefined ? (
            <small className={styles.problem}>{problemFor('headline')}</small>
          ) : null}
        </label>

        <label className={styles.field}>
          <span>Body</span>
          <textarea name="body" value={draft.body} rows={3}
                    onChange={(e) => set('body', e.target.value)} />
          {problemFor('body') !== undefined ? (
            <small className={styles.problem}>{problemFor('body')}</small>
          ) : null}
        </label>

        <div className={styles.grid}>
          <label className={styles.field}>
            <span>Call to action</span>
            <input name="cta" value={draft.cta}
                   onChange={(e) => set('cta', e.target.value)} />
            {problemFor('cta') !== undefined ? (
              <small className={styles.problem}>{problemFor('cta')}</small>
            ) : null}
          </label>

          <label className={styles.field}>
            <span>Destination (optional)</span>
            <input name="href" value={draft.href ?? ''} placeholder="https://"
                   onChange={(e) => set('href', e.target.value.trim() === '' ? null : e.target.value)} />
            {/* Says the rule up front; the server is what enforces it. */}
            <small className={styles.hint}>
              Must be an https:// address. Other kinds of link are refused.
            </small>
            {problemFor('href') !== undefined ? (
              <small className={styles.problem}>{problemFor('href')}</small>
            ) : null}
          </label>

          <label className={styles.field}>
            <span>Start time (optional)</span>
            <input type="datetime-local" name="startsAt" value={toLocalInput(draft.startsAt)}
                   onChange={(e) => set('startsAt', fromLocalInput(e.target.value))} />
            {problemFor('startsAt') !== undefined ? (
              <small className={styles.problem}>{problemFor('startsAt')}</small>
            ) : null}
          </label>

          <label className={styles.field}>
            <span>End time (optional)</span>
            <input type="datetime-local" name="endsAt" value={toLocalInput(draft.endsAt)}
                   onChange={(e) => set('endsAt', fromLocalInput(e.target.value))} />
            {problemFor('endsAt') !== undefined ? (
              <small className={styles.problem}>{problemFor('endsAt')}</small>
            ) : null}
          </label>
        </div>

        <label className={styles.toggle}>
          <input type="checkbox" name="enabled" checked={draft.enabled}
                 onChange={(e) => set('enabled', e.target.checked)} />
          <span>
            {/*
              * NOT "advertising enabled". The slot is reserved either way; this
              * chooses between YOUR creative and the house one.
              */}
            Use programme creative
            <small>
              When this is off, or outside the times above, the slot shows the
              house creative. The sponsored placement is always present.
            </small>
          </span>
        </label>

        <div className={styles.actions}>
          <button type="submit" className={styles.save} disabled={props.saving}>
            {props.saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
