import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App, { ConfigError } from './App';
import { loadContent } from './content';
import { misconfigured } from './lib/store';

const root = createRoot(document.getElementById('root')!);

function ContentErrorScreen({ message }: { message: string }) {
  return (
    <main className="mx-auto max-w-[640px] p-4">
      <h1 className="mb-3 text-lg font-semibold text-red-700">Content error</h1>
      <pre className="whitespace-pre-wrap rounded-xl border border-red-200 bg-white p-4 text-[13px] text-slate-800">{message}</pre>
    </main>
  );
}

// Screens fade in only after the first one has painted (see index.css).
requestAnimationFrame(() => setTimeout(() => document.documentElement.classList.add('app-ready'), 400));

try {
  const content = loadContent();
  document.title = content.config.studyName;
  root.render(<StrictMode>{misconfigured ? <ConfigError /> : <App c={content} />}</StrictMode>);
} catch (err) {
  console.error(err);
  root.render(<ContentErrorScreen message={err instanceof Error ? err.message : String(err)} />);
}
