import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import ActivitySheet from './components/ActivitySheet';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ActivitySheet />
  </StrictMode>,
);
