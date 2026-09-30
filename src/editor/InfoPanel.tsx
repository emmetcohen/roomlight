import { useEffect, useState } from 'react';
import { COLOR_LABELS, LABEL_CSS } from '../library/types';
import { parseKeywords } from '../library/query';
import { formatExposure } from '../metadata/exif';
import { Stars } from './LibraryPanel';
import { store, useEditor } from './store';

const fmtBytes = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fmtDate = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function Row({ k, v }: { k: string; v: string | number | undefined | null }) {
  if (v === undefined || v === null || v === '') return null;
  return <div className="info-row"><dt>{k}</dt><dd>{v}</dd></div>;
}

/** Left sidebar, "Info" tab: rating/flag/label, title/caption/keywords, file and camera metadata. */
export function InfoPanel() {
  const photo = useEditor((s) => s.photos.find((p) => p.id === s.currentId));
  const [title, setTitle] = useState(''), [caption, setCaption] = useState(''), [kw, setKw] = useState('');
  const id = photo?.id;
  useEffect(() => { setTitle(photo?.info.title ?? ''); setCaption(photo?.info.caption ?? ''); setKw((photo?.info.keywords ?? []).join(', ')); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!photo) return <div className="muted small pad">Open a photo to see its information.</div>;
  const { info } = photo, e = info.exif;
  return (
    <div className="info">
      <div className="lib-block">
        <div className="lib-row"><span className="muted">Rating</span><Stars value={info.rating} label="Rating" onPick={(n) => store.updateInfo(photo.id, { rating: info.rating === n ? 0 : n })} /></div>
        <div className="lib-row flags" role="group" aria-label="Flag">
          <button className={info.flag === 'pick' ? 'on' : ''} aria-pressed={info.flag === 'pick'} onClick={() => store.updateInfo(photo.id, { flag: info.flag === 'pick' ? 'none' : 'pick' })} title="Pick (P)">⚑ Pick</button>
          <button className={info.flag === 'reject' ? 'on' : ''} aria-pressed={info.flag === 'reject'} onClick={() => store.updateInfo(photo.id, { flag: info.flag === 'reject' ? 'none' : 'reject' })} title="Reject (X)">✕ Reject</button>
        </div>
        <div className="lib-row flags" role="group" aria-label="Color label">
          {COLOR_LABELS.map((c) => <button key={c} className={`swatch-btn${info.label === c ? ' on' : ''}`} style={{ background: LABEL_CSS[c] }} title={`Label ${c}`} aria-label={`Label ${c}`} aria-pressed={info.label === c} onClick={() => store.updateInfo(photo.id, { label: info.label === c ? null : c })} />)}
        </div>
      </div>
      <h3>Description</h3>
      <div className="lib-block fields">
        <label>Title<input className="text" aria-label="Title" value={title} onChange={(ev) => setTitle(ev.target.value)} onBlur={() => title !== info.title && store.updateInfo(photo.id, { title })} onKeyDown={(ev) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); ev.stopPropagation(); }} /></label>
        <label>Caption<textarea className="text" aria-label="Caption" rows={3} value={caption} onChange={(ev) => setCaption(ev.target.value)} onBlur={() => caption !== info.caption && store.updateInfo(photo.id, { caption })} onKeyDown={(ev) => ev.stopPropagation()} /></label>
        <label>Keywords<input className="text" aria-label="Keywords" placeholder="comma, separated" value={kw} onChange={(ev) => setKw(ev.target.value)} onBlur={() => { const k = parseKeywords(kw); setKw(k.join(', ')); if (k.join('\n') !== info.keywords.join('\n')) store.updateInfo(photo.id, { keywords: k }); }} onKeyDown={(ev) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); ev.stopPropagation(); }} /></label>
      </div>
      <h3>File</h3>
      <dl className="lib-block info-list">
        <Row k="Name" v={photo.name} /><Row k="Size" v={`${photo.width} × ${photo.height} px · ${fmtBytes(photo.size)}`} /><Row k="Imported" v={fmtDate(photo.addedAt)} />
      </dl>
      <h3>Camera</h3>
      {e === undefined ? <p className="note pad">Reading…</p> : e === null ? <p className="note pad" data-testid="no-exif">No EXIF metadata in this file{/jpe?g$/i.test(photo.name) ? '' : ' (only JPEG metadata is read)'}.</p> : (
        <dl className="lib-block info-list" data-testid="exif-list">
          <Row k="Camera" v={[e.make, e.model].filter(Boolean).join(' ')} /><Row k="Lens" v={e.lens} />
          <Row k="Captured" v={e.capturedAt ? fmtDate(e.capturedAt) : undefined} />
          <Row k="Exposure" v={[e.exposureTime ? formatExposure(e.exposureTime) : '', e.fNumber ? `f/${+e.fNumber.toFixed(1)}` : '', e.iso ? `ISO ${e.iso}` : ''].filter(Boolean).join(' · ')} />
          <Row k="Focal length" v={e.focalLength ? `${+e.focalLength.toFixed(1)} mm${e.focalLength35 ? ` (${e.focalLength35} mm equiv.)` : ''}` : undefined} />
          <Row k="Exposure bias" v={e.exposureBias !== undefined ? `${e.exposureBias > 0 ? '+' : ''}${+e.exposureBias.toFixed(2)} EV` : undefined} />
          <Row k="Software" v={e.software} /><Row k="Creator" v={e.artist} /><Row k="Copyright" v={e.copyright} />
          <Row k="Location" v={e.gps ? `${e.gps.lat.toFixed(5)}, ${e.gps.lon.toFixed(5)}` : undefined} />
        </dl>
      )}
    </div>
  );
}
