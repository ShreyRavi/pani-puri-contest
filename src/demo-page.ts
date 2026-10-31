// /demo: the shareable how-it-works page. No camera, no stall state: just the video and the steps.
import '@fontsource/titan-one/latin-400.css';
import '@fontsource/rubik/latin-400.css';
import '@fontsource/rubik/latin-700.css';
import './styles.css';
import './demo-page.css';

import { playDemo, renderSteps } from './ui/demo';
import { $ } from './ui/dom';

renderSteps($<HTMLOListElement>('demo-steps'));
// Someone opened a shared link: autoplay muted (the only autoplay browsers allow), with "Tap for sound".
playDemo($<HTMLVideoElement>('demo-video'), $<HTMLButtonElement>('demo-sound'), false);
