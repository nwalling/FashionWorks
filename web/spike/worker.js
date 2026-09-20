/* The archive worker.
 *
 * Everything to do with the P4K happens here and never on the main thread, for
 * one hard reason: the Rust side reads byte ranges *synchronously*, and the
 * only synchronous file read a browser offers is `FileReaderSync`, which exists
 * only in workers. `Blob.arrayBuffer()` cannot be awaited from inside a
 * WebAssembly call without unwinding the Rust stack. That single fact is why
 * WEB.md puts the archive in a dedicated worker.
 */
importScripts('./pkg-web/fashionworks_core.js');

const sync = new FileReaderSync();
const say = (line, kind = 'log') => postMessage({ kind, line });
const mb = (n) => (n / 1048576).toFixed(1);

onmessage = async (ev) => {
  const file = ev.data.file;
  try {
    await wasm_bindgen('./pkg-web/fashionworks_core_bg.wasm');
    const { Archive, datacoreSummary } = wasm_bindgen;

    let reads = 0, fetched = 0;
    const readRange = (offset, length) => {
      const slice = file.slice(offset, offset + length);
      const buf = sync.readAsArrayBuffer(slice);   // workers only
      reads += 1; fetched += buf.byteLength;
      return new Uint8Array(buf);
    };

    say(`file      ${file.name}`);
    say(`size      ${(file.size / 1024 ** 3).toFixed(2)} GB`);

    let t = performance.now();
    const archive = new Archive(readRange, file.size);
    const count = archive.entryCount();
    const indexMs = performance.now() - t;
    say(`\nINDEX     ${count.toLocaleString()} entries in ${(indexMs / 1000).toFixed(1)}s`);
    say(`          ${reads} range reads, ${mb(fetched)} MB fetched ` +
        `(${((fetched / file.size) * 100).toFixed(4)}% of the file)`);

    const results = { indexMs, count };

    // DataCore
    t = performance.now();
    const dcbIdx = archive.find('Data\\Game2.dcb');
    if (dcbIdx === undefined || dcbIdx === null) {
      say('\nDCB       not found in the index', 'fail');
    } else {
      const dcb = archive.read(dcbIdx);
      const readMs = performance.now() - t;
      t = performance.now();
      const summary = datacoreSummary(dcb);
      results.records = summary.records;
      say(`\nDCB       ${mb(dcb.length)} MB read in ${readMs.toFixed(0)}ms, ` +
          `${summary.records.toLocaleString()} records parsed in ${(performance.now() - t).toFixed(0)}ms`);
    }

    // A real armour control map: split across sibling mip streams.
    const ddsName = 'Data\\Objects\\Characters\\Human\\male_v7\\armor\\outlaw\\textures\\' +
                    'm_outlaw_legacy_light_armor_01_01_01_blend.dds';
    const ddsIdx = archive.find(ddsName);
    if (ddsIdx === undefined || ddsIdx === null) {
      say('\nDDS       sample texture not found (build may differ)', 'warn');
    } else {
      t = performance.now();
      const mips = archive.ddsMipCount(ddsIdx);
      const [w, h, rgba] = archive.decodeDdsEntry(ddsIdx, 0);
      say(`\nDDS       ${w}x${h}, ${mips} mips, decoded in ${(performance.now() - t).toFixed(0)}ms`);
      // A blend mask is saturated primaries; anything else means a bad decode.
      const hist = {};
      for (let i = 0; i < rgba.length; i += 4) {
        const k = (rgba[i] > 127 ? 1 : 0) | (rgba[i+1] > 127 ? 2 : 0) | (rgba[i+2] > 127 ? 4 : 0);
        hist[k] = (hist[k] || 0) + 1;
      }
      const names = ['black','red','green','yellow','blue','magenta','cyan','white'];
      const total = rgba.length / 4;
      say('          buckets: ' + Object.entries(hist).sort((a,b) => b[1]-a[1]).slice(0,4)
        .map(([k,v]) => `${names[k]} ${(100*v/total).toFixed(1)}%`).join(', '));
      results.dds = [w, h, mips];
      postMessage({ kind: 'preview', width: w, height: h, rgba }, [rgba.buffer]);
    }

    say(`\nTOTAL     ${reads} range reads, ${mb(fetched)} MB fetched`);
    if (performance.memory) {
      say(`HEAP      ${mb(performance.memory.usedJSHeapSize)} MB used, ` +
          `${mb(performance.memory.jsHeapSizeLimit)} MB limit`);
    }
    postMessage({ kind: 'done', results });
  } catch (err) {
    say(`\nERROR     ${err && err.message ? err.message : err}`, 'fail');
    postMessage({ kind: 'done', results: null });
  }
};
