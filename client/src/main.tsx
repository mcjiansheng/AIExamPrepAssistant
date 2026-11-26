import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setupApi } from './api/setup';
import { App } from './App';
import './tokens/generated/tokens.css';
import './styles/base.css';

const mode = await setupApi();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App mode={mode} />
  </StrictMode>,
);
