import { useEffect, useRef, useState } from 'react';
import { CropPanel } from './editor/CropPanel';
import { EditPanels } from './editor/EditPanels';
import { MaskPanel } from './editor/MaskPanel';
import { RetouchPanel } from './editor/RetouchPanel';
import { Filmstrip } from './editor/Filmstrip';
import { Histogram } from './editor/Histogram';
import { HistoryPanel } from './editor/HistoryPanel';
import { Viewer } from './editor/Viewer';
import { InfoPanel } from './editor/InfoPanel';
import { LibraryPanel } from './editor/LibraryPanel';
import { CopyDialog, PasteDialog, SavePresetDialog } from './editor/SettingsDialogs';
import { store, useEditor } from './editor/store';
import { SHORTCUTS, installShortcuts } from './utils/shortcuts';

export default function App() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const ready = useEditor((s) => s.ready);
  const photos = useEditor((s) => s.photos);
  const currentId = useEditor((s) => s.currentId);
  const canUndo = useEditor((s) => s.canUndo);
  const canRedo = useEditor((s) => s.canRedo);
  const showOriginal = useEditor((s) => s.showOriginal);
  const messages = useEditor((s) => s.messages);
  const params = useEditor((s) => s.params);
  const tool = useEditor((s) => s.tool);
  const dialog = useEditor((s) => s.dialog);
  const clipboard = useEditor((s) => s.clipboard);
  const selectionCount = useEditor((s) => s.selection.length);
  const [leftTab, setLeftTab] = useState<'library' | 'info' | 'history'>('library');
  const edited = store.isEdited();
  void params; void selectionCount;

  useEffect(() => {
    void store.init();
    return installShortcuts();
  }, []);

  const onFiles = (files: FileList | File[] | null) => {
    if (files && files.length) void store.importFiles(Array.from(files));
  };
  const current = photos.find((p) => p.id === currentId);

  return (
    <div
      className="app"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); onFiles(e.dataTransfer.files); }}
    >
      <header className="topbar">
        <div className="brand"><span className="brand-mark" />Roomlight</div>
        <button onClick={() => fileRef.current?.click()}>Import…</button>
        <input ref={fileRef} type="file" hidden multiple accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp,.avif,.gif,.bmp,.cr2,.cr3,.nef,.arw,.dng,.raf,.orf,.rw2,.tif,.tiff,.heic,.heif" onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} />
        <div className="tools" role="tablist" aria-label="Tools">
          {([['edit', 'Edit', 'E'], ['crop', 'Crop', 'C'], ['mask', 'Masking', 'M'], ['retouch', 'Retouch', 'Q']] as const).map(([id, label, key]) => (
            <button key={id} role="tab" aria-selected={tool === id} data-tool={id} className={tool === id ? 'on' : ''} disabled={!current} onClick={() => store.setTool(id)} title={`${label} (${key})`}>{label}</button>
          ))}
        </div>
        <div className="spacer" />
        <div className="file-name">{current ? `${current.name} · ${current.width}×${current.height}` : ''}</div>
        <div className="spacer" />
        <button onClick={store.undo} disabled={!canUndo} title="Undo (Ctrl/Cmd+Z)">Undo</button>
        <button onClick={store.redo} disabled={!canRedo} title="Redo (Ctrl/Cmd+Shift+Z)">Redo</button>
        <button disabled={!current} onClick={() => store.openDialog('copy')} title="Copy settings… (Ctrl/Cmd+Shift+C)">Copy</button>
        <button disabled={!current || !clipboard} onClick={() => store.openDialog('paste')} title="Paste settings… (Ctrl/Cmd+Shift+V)">Paste</button>
        <button className={showOriginal ? 'on' : ''} disabled={!current} onClick={() => store.toggleOriginal()} title="Before / after ( \ )">Before</button>
        <button disabled={!edited} onClick={store.resetAll} title="Reset all edits">Reset All</button>
        {current && <button className="danger" onClick={() => { if (confirm(`Remove “${current.name}” and its edits from the library? The file on your disk is not touched.`)) void store.removePhoto(current.id); }}>Remove</button>}
      </header>

      <aside className="left">
        <div className="seg wide left-tabs" role="tablist" aria-label="Sidebar">
          {([['library', 'Library'], ['info', 'Info'], ['history', 'History']] as const).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={leftTab === id} data-left-tab={id} className={leftTab === id ? 'on' : ''} onClick={() => setLeftTab(id)}>{label}</button>
          ))}
        </div>
        {leftTab === 'library' && <LibraryPanel />}
        {leftTab === 'info' && <InfoPanel />}
        {leftTab === 'history' && <HistoryPanel />}
        <h3>Shortcuts</h3>
        <ul className="shortcuts">
          {SHORTCUTS.map((s) => <li key={s.id}><span>{s.label}</span><kbd>{(s.display ?? s.keys[0]).replace('mod', '⌘/Ctrl').replace('arrowright', '→').replace('arrowleft', '←')}</kbd></li>)}
        </ul>
      </aside>

      <main className="center">
        {ready && photos.length === 0 ? (
          <div className="empty">
            <h2>Drop photos here</h2>
            <p>JPEG, PNG and WebP are supported. Originals are stored untouched; edits are saved as parameters.</p>
            <button className="primary" onClick={() => fileRef.current?.click()}>Import photos…</button>
          </div>
        ) : (
          <Viewer />
        )}
        {dragging && <div className="drop-overlay">Drop to import</div>}
      </main>

      <aside className="right">
        <Histogram />
        <div className="right-scroll">
          {!current ? <div className="muted small pad">Import or select a photo to start editing.</div>
            : tool === 'crop' ? <CropPanel />
            : tool === 'mask' ? <MaskPanel />
            : tool === 'retouch' ? <RetouchPanel />
            : <EditPanels />}
        </div>
      </aside>

      <footer className="bottom"><Filmstrip /></footer>

      {dialog === 'copy' && <CopyDialog />}
      {dialog === 'paste' && <PasteDialog />}
      {dialog === 'savePreset' && <SavePresetDialog />}
      <div className="toasts">
        {messages.map((m, i) => <div className="toast" key={i} role="alert" onClick={() => store.dismissMessage(i)}>{m}</div>)}
      </div>
    </div>
  );
}
