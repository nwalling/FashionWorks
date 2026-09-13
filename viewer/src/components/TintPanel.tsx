import { useMemo } from 'react';

import { selectableItems } from '../manifest';
import { useStore } from '../store';

/**
 * Per-item tint. v1 recolours the whole piece; once the pipeline emits tint
 * masks (materials.json marks which slots are tintable), this switches to
 * per-material-slot colours.
 */
export function TintPanel() {
  const manifest = useStore((state) => state.manifest);
  const loadout = useStore((state) => state.loadout);
  const setTint = useStore((state) => state.setTint);

  const equipped = useMemo(() => {
    if (!manifest) return [];
    const byId = new Map(selectableItems(manifest).map((item) => [item.id, item]));
    return Object.values(loadout.slots)
      .filter((id): id is string => id !== null)
      .map((id) => byId.get(id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
  }, [manifest, loadout.slots]);

  if (equipped.length === 0) {
    return (
      <section className="panel tint">
        <h2>Tint</h2>
        <p className="empty">Equip a piece to tint it.</p>
      </section>
    );
  }

  return (
    <section className="panel tint">
      <h2>Tint</h2>
      <ul>
        {equipped.map((item) => (
          <li key={item.id}>
            <label>
              <span>{item.name}</span>
              <input
                type="color"
                value={loadout.tints[item.id] ?? '#8a9099'}
                onChange={(event) => setTint(item.id, event.target.value)}
              />
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
