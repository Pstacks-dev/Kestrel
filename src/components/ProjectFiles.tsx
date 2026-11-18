import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, File, FileArchive, Folder, FolderPlus, RefreshCw, Trash2, Upload, X } from 'lucide-react';

type Entry = { name: string; isFolder: boolean; sizeBytes: number | null; contentType: string | null; updatedAt: string | null };

function formatSize(bytes: number | null) {
  if (bytes === null) return 'Folder';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ProjectFiles({ projectId, accessToken, apiBase }: { projectId: string; accessToken: string; apiBase: string }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploadMessage, setUploadMessage] = useState('');
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (folder) params.set('path', folder);
      const response = await fetch(`${apiBase}/projects/${projectId}/files?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load project files');
      setEntries(data.files || []);
    } catch (err: any) {
      setError(err.message || 'Could not load project files');
    } finally {
      setBusy(false);
    }
  }, [apiBase, projectId, accessToken, folder]);

  useEffect(() => { load(); }, [load]);

  async function uploadFiles(input: FileList | File[]) {
    const files = Array.from(input);
    if (!files.length) return;
    setBusy(true);
    setError('');
    let completed = 0;
    try {
      for (const file of files) {
        if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} exceeds the 20 MB per-file limit`);
        const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        const path = [folder, relative].filter(Boolean).join('/');
        const response = await fetch(`${apiBase}/projects/${projectId}/files?${new URLSearchParams({ path })}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/octet-stream',
            'X-File-Content-Type': file.type || 'application/octet-stream',
          },
          body: file,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Upload failed: ${file.name}`);
        completed += 1;
        setUploadMessage(`Uploaded ${completed} of ${files.length} files`);
      }
      setUploadMessage(`Uploaded ${completed} file${completed === 1 ? '' : 's'} successfully`);
      await load();
    } catch (err: any) {
      setError(err.message || 'Upload failed');
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
      if (folderInput.current) folderInput.current.value = '';
    }
  }

  async function download(path: string) {
    try {
      const response = await fetch(`${apiBase}/projects/${projectId}/files/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ path }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Download failed');
      window.open(data.url, '_blank', 'noopener,noreferrer');
    } catch (err: any) {
      setError(err.message || 'Download failed');
    }
  }

  async function remove(path: string) {
    if (!window.confirm(`Delete ${path} from this project?`)) return;
    try {
      const response = await fetch(`${apiBase}/projects/${projectId}/files?${new URLSearchParams({ path })}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Delete failed');
      await load();
    } catch (err: any) {
      setError(err.message || 'Delete failed');
    }
  }

  const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';

  return (
    <section className="project-files">
      <div className="project-files-head">
        <div>
          <h4>Project files</h4>
          <p>Upload a source folder or individual files. Files are private to this workspace.</p>
        </div>
        <button type="button" className="project-files-refresh" onClick={load} disabled={busy} aria-label="Refresh files"><RefreshCw size={14}/></button>
      </div>
      <div className={`project-files-drop ${dragging ? 'is-dragging' : ''}`}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
        onDrop={(event) => { event.preventDefault(); setDragging(false); void uploadFiles(event.dataTransfer.files); }}>
        <Upload size={22}/>
        <b>Drop files here, or choose a folder</b>
        <span>Or choose files from your computer · Maximum 20 MB per file</span>
        <div className="project-files-actions">
          <button type="button" onClick={() => fileInput.current?.click()} disabled={busy}>Choose files</button>
          <button type="button" onClick={() => folderInput.current?.click()} disabled={busy}><FolderPlus size={13}/> Choose folder</button>
        </div>
        <input ref={fileInput} type="file" multiple hidden onChange={(event) => event.target.files && void uploadFiles(event.target.files)}/>
        <input ref={folderInput} type="file" multiple hidden {...({ webkitdirectory: '', directory: '' } as any)} onChange={(event) => event.target.files && void uploadFiles(event.target.files)}/>
      </div>
      {uploadMessage && <p className="project-files-message" role="status">{uploadMessage}</p>}
      {error && <p className="project-files-error" role="alert">{error}</p>}
      <div className="project-files-path">
        <button type="button" onClick={() => setFolder('')} disabled={!folder}><Folder size={14}/> root</button>
        {folder && <><span>/</span><span>{folder}</span></>}
      </div>
      {folder && <button type="button" className="project-files-parent" onClick={() => setFolder(parent)}><ArrowLeft size={13}/> Parent folder</button>}
      <div className="project-files-list">
        {busy && !entries.length ? <p className="project-files-empty">Loading project files…</p> :
          entries.length ? entries.map((entry) => {
            const path = [folder, entry.name].filter(Boolean).join('/');
            return <div className="project-file-row" key={path}>
              <span className="project-file-icon">{entry.isFolder ? <Folder size={16}/> : entry.name.toLowerCase().endsWith('.zip') ? <FileArchive size={16}/> : <File size={16}/>}</span>
              <button type="button" className="project-file-name" onClick={() => entry.isFolder ? setFolder(path) : void download(path)}>{entry.name}</button>
              <small>{formatSize(entry.sizeBytes)}</small>
              {!entry.isFolder && <button type="button" title="Download" onClick={() => void download(path)}><ArrowDown size={14}/></button>}
              {!entry.isFolder && <button type="button" title="Delete" onClick={() => void remove(path)}><Trash2 size={14}/></button>}
            </div>;
          }) : <p className="project-files-empty">No files in this folder yet.</p>}
      </div>
      <p className="project-files-footnote"><X size={12}/> Uploads are stored privately. Pipeline execution from uploaded source will be enabled after the project-source runner is connected.</p>
    </section>
  );
}
