// /demo: the shareable how-it-works page. No camera, no stall state: just the video and the steps.
import '@fontsource/titan-one/latin-400.css';
import '@fontsource/rubik/latin-400.css';
import '@fontsource/rubik/latin-700.css';
import './styles.css';
import './demo-page.css';

import { playDemo, renderSteps } from './ui/demo';
import { $ } from './ui/dom';

renderSteps($<HTMLOListElement>('demo-steps'));
// Autoplays with sound where the browser allows it; otherwise muted until the first tap or key press.
playDemo($<HTMLVideoElement>('demo-video'), $<HTMLButtonElement>('demo-sound'));
