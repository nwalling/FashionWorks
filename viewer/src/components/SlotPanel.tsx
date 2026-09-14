import { useMemo, useState } from 'react';

import type { Item, Slot } from '../manifest';
import { SLOTS, paletteColor, selectableItems, variantsOf } from '../manifest';
import { useStore } from '../store';

function uniqueSorted(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))].sort();
}

export function SlotPanel() {
  const manifest = useStore((state) => state.manifest);
  const loadout = useStore((state) => state.loadout);
  const filters = useStore((state) => state.filters);
  const setFilter = useStore((state) => state.setFilter);
  const equip = useStore((state) => state.equip);
  const equipSet = useStore((state) => state.equipSet);
  const visibleItems = useStore((state) => state.visibleItems);
  const [activeSlot, setActiveSlot] = useState<Slot>('helmet');

  const all = useMemo(() => (manifest ? selectableItems(manifest) : []), [manifest]);
  const byId = useMemo(() => new Map(all.map((item) => [item.id, item])), [all]);
  const weightClasses = useMemo(() => uniqueSorted(all.map((i) => i.weight_class)), [all]);
  const manufacturers = useMemo(() => uniqueSorted(all.map((i) => i.manufacturer.code)), [all]);
  const sets = useMemo(() => uniqueSorted(all.map((i) => i.set)), [all]);

  const items = visibleItems(activeSlot);
  const equippedId = loadout.slots[activeSlot];

  return (
    <section className="panel">
      <nav className="tabs">
        {SLOTS.map((slot) => (
          <button
            key={slot}
            className={slot === activeSlot ? 'tab active' : 'tab'}
            onClick={() => setActiveSlot(slot)}
          >
            {slot}
            {loadout.slots[slot] ? <span className="dot" /> : null}
          </button>
        ))}
      </nav>

      <div className="filters">
        <input
          type="search"
          placeholder="Search"
          value={filters.search}
          onChange={(event) => setFilter('search', event.target.value)}
        />
        <select
          value={filters.weightClass ?? ''}
          onChange={(event) => setFilter('weightClass', event.target.value || null)}
        >
          <option value="">Any weight</option>
          {weightClasses.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          value={filters.manufacturer ?? ''}
          onChange={(event) => setFilter('manufacturer', event.target.value || null)}
        >
          <option value="">Any maker</option>
          {manufacturers.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          value={filters.set ?? ''}
          onChange={(event) => setFilter('set', event.target.value || null)}
        >
          <option value="">Any set</option>
          {sets.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>

      <ul className="items">
        <li>
          <button
            className={equippedId === null ? 'item active' : 'item'}
            onClick={() => equip(activeSlot, null)}
          >
            <span className="item-name">None</span>
          </button>
        </li>
        {items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            equippedId={equippedId}
            variants={variantsOf(item, byId)}
            onEquip={(id) => equip(activeSlot, id)}
            onEquipSet={(anchorId) => (item.set ? equipSet(item.set, anchorId) : undefined)}
          />
        ))}
        {items.length === 0 ? <li className="empty">No items match these filters.</li> : null}
      </ul>
    </section>
  );
}


/**
 * The name the whole colour group shares, as whole words.
 *
 * A group used to be titled with whichever member happened to be canonical, so
 * the twenty-one Odyssey II undersuits appeared as "Odyssey II Undersuit
 * Alpha" with the other twenty as swatches beneath it. Alpha is a colourway in
 * its own right, not the parent of the others, and the game lists all of them
 * as separate items. Titling the group with what the names actually share, and
 * naming the selected colourway separately, stops one member standing in for
 * the rest.
 */
function sharedName(items: Item[]): string {
  const words = items.map((item) => item.name.trim().split(/\s+/));
  if (words.length === 0) return '';
  const first = words[0];
  let shared = 0;
  while (shared < first.length && words.every((w) => w[shared] === first[shared])) shared += 1;
  return first.slice(0, shared).join(' ');
}

/** What distinguishes one colourway from the rest of its group. */
function colourwayName(item: Item, shared: string): string {
  if (!shared || item.name.length <= shared.length) return '';
  return item.name.slice(shared.length).trim();
}

function ItemRow({
  item,
  equippedId,
  variants,
  onEquip,
  onEquipSet,
}: {
  item: Item;
  equippedId: string | null;
  variants: Item[];
  onEquip: (id: string) => void;
  onEquipSet: (anchorId: string) => void;
}) {
  const activeVariant = variants.find((v) => v.id === equippedId) ?? item;
  const isEquipped = variants.some((v) => v.id === equippedId);
  const grouped = variants.length > 1;
  const shared = grouped ? sharedName(variants) : '';
  const title = grouped && shared ? shared : item.name;
  const colourway = grouped ? colourwayName(activeVariant, shared) : '';

  return (
    <li>
      <button
        className={isEquipped ? 'item active' : 'item'}
        onClick={() => onEquip(activeVariant.id)}
      >
        <span className="item-name">{title}</span>
        {colourway ? <span className="item-colourway">{colourway}</span> : null}
        <span className="item-meta">
          {[item.manufacturer.code, item.weight_class].filter(Boolean).join(' · ')}
        </span>
      </button>
      {grouped ? (
        <div className="swatches">
          {variants.map((variant) => (
            <button
              key={variant.id}
              title={colourwayName(variant, shared) || variant.name}
              className={variant.id === equippedId ? 'swatch active' : 'swatch'}
              style={{ background: swatchColor(variant) }}
              onClick={() => onEquip(variant.id)}
            />
          ))}
        </div>
      ) : null}
      {item.set ? (
        <button className="link" onClick={() => onEquipSet(activeVariant.id)}>
          equip full set
        </button>
      ) : null}
    </li>
  );
}

function swatchColor(item: Item): string {
  return paletteColor(item) ?? '#4a5058';
}
