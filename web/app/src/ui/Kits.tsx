/** The kits panel: save the outfit on screen to the visitor's profile as a
 * kit, or put on one of their kits. The host keeps the kits (`KitsHost`);
 * this asks it to save and reads what it lists. Without a profile it
 * suggests starting one. `kits.ts` and WEB-INTEGRATION.md §2.4.
 */

import { useEffect, useId, useRef, useState } from 'react';

import type { Catalogue } from '../archive/catalogue';
import { kitOutfit, kitReach, suggestKitName, type HostKit, type KitsHost } from '../kits';
import type { Kitbasher as Engine, KitbasherState } from '../three/kitbasher';

export interface KitsProps {
  readonly engine: Engine;
  readonly state: KitbasherState;
  readonly catalogue: Catalogue;
  readonly host: KitsHost;
  readonly onClose: () => void;
}

/** A kit name's longest: the profile page lists them on one line. */
const NAME_MAX = 60;

export function Kits(props: KitsProps): JSX.Element {
  const { engine, state, catalogue, host, onClose } = props;
  const titleId = useId();
  const nameId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(() => suggestKitName(state.wearing));
  const [saving, setSaving] = useState(false);
  const [wearing, setWearing] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const pieces = state.wearing.size + state.carrying.size;

  // Escape closes; focus starts in the panel and goes back on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('input, button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [onClose]);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setNote(null);
    try {
      await host.save(trimmed, kitOutfit(state.wearing, state.carrying, engine.loadout(), state.body));
      setNote({ text: `Saved "${trimmed}" to your kits.` });
    } catch (error) {
      setNote({ text: error instanceof Error && error.message ? error.message : 'The kit could not be saved.', error: true });
    } finally {
      setSaving(false);
    }
  };

  const wear = async (kit: HostKit) => {
    setWearing(kit.id);
    setNote(null);
    try {
      const count = await engine.wearKit(kit);
      setNote({ text: `${kit.name}: ${count} ${count === 1 ? 'piece' : 'pieces'} on.` });
    } finally {
      setWearing(null);
    }
  };

  return (
    <div ref={panel} className="fw-kit-portrait fw-kit-kits" role="dialog" aria-labelledby={titleId}>
      <div className="fw-kit-portrait-head">
        <h2 id={titleId} className="fw-kit-portrait-title">Kits</h2>
        <button type="button" aria-label="Close kits" title="Close" onClick={onClose}>×</button>
      </div>
      {!host.signedIn ? (
        <>
          <p className="fw-kit-portrait-hint">
            Kits are kept on your profile: save this outfit to wear it again, or ask your org to craft it.
          </p>
          <button type="button" className="fw-kit-portrait-save" onClick={() => host.startProfile()}>
            Start a profile
          </button>
        </>
      ) : (
        <>
          <form
            className="fw-kit-kits-save"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label htmlFor={nameId} className="fw-kit-label">save this outfit as</label>
            <input
              id={nameId}
              className="fw-kit-search"
              type="text"
              maxLength={NAME_MAX}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <button
              type="submit"
              className="fw-kit-portrait-save"
              disabled={saving || pieces === 0 || !name.trim()}
              title={pieces === 0 ? 'Nothing is worn or carried' : 'Save what is on to your profile as a new kit'}
            >
              {saving ? 'saving…' : 'save kit'}
            </button>
          </form>
          <div className="fw-kit-kits-list" role="list" aria-label="Your kits">
            <span className="fw-kit-label">wear a kit</span>
            {host.kits.length === 0 && <p className="fw-kit-portrait-hint">No kits yet.</p>}
            {host.kits.map((kit) => {
              const reach = kitReach(kit, catalogue);
              return (
                <div key={kit.id} className="fw-kit-kits-row" role="listitem">
                  <span className="fw-kit-kits-name" title={kit.name}>{kit.name}</span>
                  <span className="fw-kit-kits-meta">
                    {reach === 0 ? 'nothing to wear' : `${reach} ${reach === 1 ? 'piece' : 'pieces'}`}
                  </span>
                  <button
                    type="button"
                    disabled={reach === 0 || wearing !== null || state.busy}
                    title={reach === 0
                      ? 'None of this kit is armor, clothing or a weapon this tool can show'
                      : `Put on ${kit.name} in place of what is worn`}
                    onClick={() => void wear(kit)}
                  >
                    {wearing === kit.id ? 'wearing…' : 'wear'}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
      {note && (
        <p className="fw-kit-portrait-hint" role="status" data-error={note.error ? '' : undefined}>{note.text}</p>
      )}
    </div>
  );
}
