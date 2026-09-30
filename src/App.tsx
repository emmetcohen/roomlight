import { useEffect, useRef, useState } from 'react';
import { CropTool } from './editor/CropPanel';
import { EditPanels } from './editor/EditPanels';
import { ExportDialog } from './editor/ExportDialog';
import { CopyDialog, PasteDialog, SavePresetDialog } from './editor/SettingsDialogs';
import { MaskPanel } from './editor/MaskPanel';
import { RetouchPanel } from './editor/RetouchPanel';
import { Filmstrip } from './editor/Filmstrip';
import { Histogram } from './editor/Histogram';
import { InfoPanel } from './editor/InfoPanel';
import { LeftPanel } from './editor/LeftPanel';
import { LibraryPanel } from './editor/LibraryPanel';
import { LibraryGrid } from './editor/LibraryView';
import { ToolStrip } from './editor/ToolStrip';
import { Viewer } from './editor/Viewer';
import { store, useEditor } from './editor/store';
import { installShortcuts } from './utils/shortcuts';

const ACCEPT = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp,.avif,.gif,.bmp,.cr2,.cr3,.nef,.arw,.dng,.raf,.orf,.rw2,.tif,.tiff,.heic,.heif';

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
  const tool = useEditor((s) => s.tool);
  const mode = useEditor((s) => s.mode);
  const dialog = useEditor((s) => s.dialog);

  useEffect(() => {
    void store.init();
    return installShortcuts();
  }, []);

  const onFiles = (files: FileList | File[] | null) => {
    if (files && files.length) void store.importFiles(Array.from(files));
  };
  const pickFiles = () => fileRef.current?.click();
  const current = photos.find((p) => p.id === currentId);
  const edit = mode === 'edit';

  return (
    <div
      className={`app mode-${mode}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); onFiles(e.dataTransfer.files); }}
    >
      <input ref={fileRef} type="file" hidden multiple accept={ACCEPT} onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} />

      <header className="topbar">
        <div className="brand"><span className="brand-mark" />Roomlight</div>
        <div className="seg mode-switch" role="tablist" aria-label="Module">
          <button role="tab" aria-selected={mode === 'library'} data-mode="library" className={mode === 'library' ? 'on' : ''} onClick={() => store.setMode('library')} title="Library (G)">Library</button>
          <button role="tab" aria-selected={mode === 'edit'} data-mode="edit" className={mode === 'edit' ? 'on' : ''} disabled={!current} onClick={() => store.setMode('edit')} title="Edit (E)">Edit</button>
        </div>
        <div className="spacer" />
        <div className="file-name" data-testid="file-name">{current ? `${current.name} · ${current.width}×${current.height}` : ''}</div>
        <div className="spacer" />
        <button onClick={store.undo} disabled={!edit || !canUndo} title="Undo (Ctrl/Cmd+Z)">Undo</button>
        <button onClick={store.redo} disabled={!edit || !canRedo} title="Redo (Ctrl/Cmd+Shift+Z)">Redo</button>
        <button className={showOriginal ? 'on' : ''} disabled={!edit || !current} onClick={() => store.toggleOriginal()} title="Before / after ( \ )">Before / After</button>
        <button className="primary-sm" disabled={!current} data-testid="open-export" onClick={() => store.openDialog('export')} title="Export… (Ctrl/Cmd+Shift+E)">Export…</button>
      </header>

      {edit ? (
        <>
          <aside className="left"><LeftPanel /></aside>
          <main className="center">
            {ready && photos.length === 0 ? (
              <div className="empty">
                <h2>No photos yet</h2>
                <p>Import photos in the Library, or drop files here.</p>
                <button className="primary" onClick={pickFiles}>Import photos…</button>
              </div>
            ) : <Viewer />}
            {dragging && <div className="drop-overlay">Drop to import</div>}
          </main>
          <aside className="right">
            <Histogram />
            <div className="right-scroll" data-tool-panel={tool}>
              {!current ? <div className="muted small pad">Open a photo from the Library to start editing.</div>
                : tool === 'crop' ? <CropTool />
                : tool === 'mask' ? <MaskPanel />
                : tool === 'retouch' ? <RetouchPanel />
                : <EditPanels />}
            </div>
          </aside>
          <ToolStrip />
          <footer className="bottom"><Filmstrip /></footer>
        </>
      ) : (
        <>
          <aside className="left"><LibraryPanel /></aside>
          <main className="center">
            <LibraryGrid onImport={pickFiles} />
            {dragging && <div className="drop-overlay">Drop to import</div>}
          </main>
          <aside className="right"><div className="right-scroll"><InfoPanel /></div></aside>
        </>
      )}

      {dialog === 'copy' && <CopyDialog />}
      {dialog === 'paste' && <PasteDialog />}
      {dialog === 'savePreset' && <SavePresetDialog />}
      {dialog === 'export' && <ExportDialog />}
      <div className="toasts">
        {messages.map((m, i) => <div className="toast" key={i} role="alert" onClick={() => store.dismissMessage(i)}>{m}</div>)}
      </div>
    </div>
  );
}
