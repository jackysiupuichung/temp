import { useEffect, useState } from 'react';
import { Library } from './components/Library';
import { Editor } from './components/Editor';
import './api/notebookApi';

function routeFromHash(): string | null {
  const m = /^#\/doc\/([^/]+)/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

export default function App() {
  const [docId, setDocId] = useState<string | null>(routeFromHash);
  useEffect(() => {
    const onHash = () => setDocId(routeFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  if (docId) return <Editor docId={docId} onBack={() => { location.hash = ''; }} />;
  return <Library onOpen={(id) => { location.hash = `#/doc/${encodeURIComponent(id)}`; }} />;
}
