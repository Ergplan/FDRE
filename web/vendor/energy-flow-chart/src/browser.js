// Entry for the <script> bundle: exposes window.EnergyFlow and auto-mounts
// any element with a data-energy-flow attribute.
import * as EnergyFlow from './index.js';

if (typeof window !== 'undefined') {
  window.EnergyFlow = EnergyFlow;
  const run = () => EnergyFlow.autoMount();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
}

export default EnergyFlow;
