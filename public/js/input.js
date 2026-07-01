// Centralized input. Tracks keys, mouse position (in screen px), buttons,
// and edge-triggered events (just-pressed) the game polls each frame.

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();   // keys that went down this frame
    this.mouse = { x: 0, y: 0 };
    this.mouseDown = false;
    this.mouseClicked = false;  // left button went down this frame
    this.rightDown = false;     // right button held (aim down sights)
    this.wheel = 0;             // accumulated wheel delta this frame
    this.weaponSlot = null;     // 1..9 requested this frame, or null
    this.cycleWeapon = 0;       // -1 / +1 requested this frame

    this._bind();
  }

  _bind() {
    addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (!this.keys.has(k)) this.pressed.add(k);
      this.keys.add(k);
      if (k >= '1' && k <= '9') this.weaponSlot = parseInt(k, 10);
      if (k === 'q') this.cycleWeapon = 1;
      // Stop browser scrolling / quick-find on game keys.
      if (['w', 'a', 's', 'd', ' ', 'q', 'r', "'", '/'].includes(k)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));

    const setMouse = (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.mouse.x = e.clientX - r.left;
      this.mouse.y = e.clientY - r.top;
    };
    this.canvas.addEventListener('mousemove', setMouse);
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) { this.mouseDown = true; this.mouseClicked = true; }
      if (e.button === 2) this.rightDown = true;
      setMouse(e);
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseDown = false;
      if (e.button === 2) this.rightDown = false;
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || this.keys.has('control')) {
        this.wheel += e.deltaY;           // Ctrl+scroll = zoom
      } else {
        this.cycleWeapon += e.deltaY > 0 ? 1 : -1; // scroll = switch weapon
      }
    }, { passive: false });
  }

  down(k) { return this.keys.has(k); }
  justPressed(k) { return this.pressed.has(k); }

  // Call at the very end of each frame to clear edge-triggered state.
  endFrame() {
    this.pressed.clear();
    this.mouseClicked = false;
    this.wheel = 0;
    this.weaponSlot = null;
    this.cycleWeapon = 0;
  }
}
