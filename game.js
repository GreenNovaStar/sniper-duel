const W = 960, H = 540, SCOPE_R = 130;
const WORLD_W = 2880; // 3 screens wide; pan with mouse at screen edges
// ponytail: all game-feel tuning lives here
const TUNE = {
  hp: 3,
  botAccuracy: 0.85,   // hit chance vs a still target; a moving crosshair halves it
  coverAccuracy: 0.12, // chance a shot clips you through/over the sandbags
  aimTime: 2800,       // ms of clean tracking the sniper needs to line up a shot
  aimDrain: 0.4,       // aim lost per second while you're ducked (sniper remembers your spot)
  shotCooldown: 3000,  // ms the sniper waits after firing before re-aiming
  boltTime: 1800,      // ms to cycle your bolt between shots
  enemiesPerMap: 5,    // snipers to clear before the round ends
  stillSpeed: 3,       // px/frame under which you count as "holding still"
  dwellMin: 5000, dwellMax: 9000,  // how long the sniper stays at one window
  gapMin: 1000, gapMax: 2500,      // gap before reappearing at a new window
  hintEvery: 2500,                 // ms between faint scope-glint hints
  grace: 200,                      // ms after scoping before the sniper can aim
  zoom: 2.2,
  panEdge: 60, panSpeed: 550,      // push mouse to a screen edge to pan (px zone, px/s)
};
const rand = (a,b) => a + Math.random()*(b-a);

// difficulty = how many snipers hunt you at once (picked on the main menu);
// mult scales all scoring
const DIFFS = [
  {name: 'Easy',   concurrent: 1, mult: 1},
  {name: 'Normal', concurrent: 2, mult: 2},
  {name: 'Hard',   concurrent: 3, mult: 3},
];

// each kill advances the clock; tint washes over the whole city
const PHASES = [
  {name: 'Morning',   color: 0xffe8c0, alpha: 0.10},
  {name: 'Afternoon', color: 0xffffff, alpha: 0.00},
  {name: 'Dusk',      color: 0xff8844, alpha: 0.20},
  {name: 'Evening',   color: 0x223366, alpha: 0.32},
  {name: 'Night',     color: 0x0a1030, alpha: 0.48},
];

function makeTextures(scene) {
  let g = scene.add.graphics();
  // sniper silhouette: head + shoulders + rifle line
  g.fillStyle(0x23232c); g.fillRect(2,14,20,14);
  g.fillCircle(12,8,7);
  g.lineStyle(2,0x33333d); g.lineBetween(4,18,24,10);
  g.generateTexture('sniper',26,28); g.clear();
  // player's sandbag cover (bottom of screen)
  g.fillStyle(0x8a7a55); g.fillRect(0,0,W,120);
  g.fillStyle(0x9c8c64);
  for (let r=0; r<3; r++) for (let c=0; c<9; c++)
    g.fillEllipse(60+c*110+(r%2)*55, 24+r*38, 100, 32);
  g.generateTexture('cover',W,120); g.clear();
  g.destroy();
}

class MenuScene extends Phaser.Scene {
  constructor() { super({key: 'menu'}); }

  create() {
    const saved = JSON.parse(localStorage.getItem('sniperDuel') || '{}');
    this.add.rectangle(W/2, H/2, W, H, 0x141821);
    this.add.text(W/2, 120, 'SNIPER DUEL', {fontSize: 56, color: '#fff', fontStyle: 'bold'}).setOrigin(0.5);
    this.add.text(W/2, 180, 'choose your hunt', {fontSize: 18, color: '#8a94a6'}).setOrigin(0.5);

    DIFFS.forEach((d, i) => {
      const t = this.add.text(W/2, 260 + i*56, `${d.name} — ${d.concurrent} sniper${d.concurrent > 1 ? 's' : ''} at once (${d.mult}x score)`,
        {fontSize: 26, color: '#cfd8e3', backgroundColor: '#222c3a', padding: {x: 24, y: 8}})
        .setOrigin(0.5).setInteractive({useHandCursor: true});
      t.on('pointerover', () => t.setColor('#ffee88'));
      t.on('pointerout', () => t.setColor('#cfd8e3'));
      t.on('pointerdown', () => this.scene.start('duel', {phase: 0, score: 0, diff: i}));
    });

    if (saved.score > 0 || saved.phase > 0) {
      const c = this.add.text(W/2, 470, `Continue — ${PHASES[saved.phase ?? 0].name}, score ${saved.score ?? 0} (${DIFFS[saved.diff ?? 0].name})`,
        {fontSize: 20, color: '#9fd89f', backgroundColor: '#1d2a1d', padding: {x: 20, y: 6}})
        .setOrigin(0.5).setInteractive({useHandCursor: true});
      c.on('pointerdown', () => this.scene.start('duel', {}));
    }
  }
}

class DuelScene extends Phaser.Scene {
  constructor() { super({key: 'duel'}); }

  // round state carried across scene restarts: {phase, score, diff}
  init(data) {
    // scene.restart passes data; on a fresh page load fall back to saved progress
    const saved = JSON.parse(localStorage.getItem('sniperDuel') || '{}');
    this.phase = data.phase ?? saved.phase ?? 0;
    this.startScore = data.score ?? saved.score ?? 0;
    this.diff = data.diff ?? saved.diff ?? 0;
    this.cleared = false;
    this.save();
  }

  save() {
    localStorage.setItem('sniperDuel', JSON.stringify({phase: this.phase, score: this.startScore, diff: this.diff}));
  }

  create() {
    makeTextures(this);
    this.input.mouse.disableContextMenu();
    this.hp = TUNE.hp; this.score = this.startScore; this.kills = 0; this.over = false;
    this.shots = 0; this.hits = 0;
    this.scoped = false; this.scopedAt = 0; this.nextShotAt = 0;

    this.cameras.main.setBounds(0, 0, WORLD_W, H);
    this.buildCity();

    // time-of-day tint over the whole city (under the HUD/cover)
    const ph = PHASES[this.phase];
    this.tint = this.add.rectangle(WORLD_W/2, H/2, WORLD_W, H, ph.color, ph.alpha).setDepth(40);

    // player cover + HUD (main camera only)
    this.cover = this.add.image(W/2, H-60, 'cover').setDepth(50).setScrollFactor(0);
    this.ring = this.add.graphics().setDepth(100).setVisible(false);
    this.ring.lineStyle(3, 0x111111).strokeCircle(0,0,SCOPE_R);
    // mil-dot reticle: thick outer posts, hairline center cross, dots along each axis
    this.ring.lineStyle(4, 0x111111)
      .lineBetween(-SCOPE_R,0,-52,0).lineBetween(52,0,SCOPE_R,0)
      .lineBetween(0,-SCOPE_R,0,-52).lineBetween(0,52,0,SCOPE_R);
    this.ring.lineStyle(1, 0x111111)
      .lineBetween(-52,0,52,0).lineBetween(0,-52,0,52);
    this.ring.fillStyle(0x111111);
    for (const d of [22, 40]) {
      this.ring.fillCircle(d,0,1.8).fillCircle(-d,0,1.8)
        .fillCircle(0,d,1.8).fillCircle(0,-d,1.8);
    }
    this.cross = this.add.circle(0,0,3,0x111111).setDepth(100);
    this.scoreText = this.add.text(16,12,'Score: 0',{fontSize:20,color:'#fff'}).setDepth(110).setScrollFactor(0);
    this.phaseText = this.add.text(W/2,12,'',{fontSize:18,color:'#ffd'}).setOrigin(0.5,0).setDepth(110).setScrollFactor(0);
    this.hpText = this.add.text(W-16,12,'',{fontSize:22,color:'#e33'}).setOrigin(1,0).setDepth(110).setScrollFactor(0);
    this.msgText = this.add.text(W/2,H/2,'',{fontSize:32,color:'#fff',backgroundColor:'#000a',padding:{x:16,y:8}}).setOrigin(0.5).setDepth(110).setVisible(false).setScrollFactor(0);
    this.updateHud();

    // scope: second zoomed camera, circle-masked, follows pointer
    this.scopeCam = this.cameras.add(0,0,W,H).setZoom(TUNE.zoom).setVisible(false);
    this.maskG = this.make.graphics({}, false);
    this.maskG.fillStyle(0xffffff).fillCircle(0,0,SCOPE_R);
    this.scopeCam.setMask(new Phaser.Display.Masks.GeometryMask(this, this.maskG));
    // scope cam draws over the main cam inside the mask, so it must render the
    // reticle itself; ring/cross are kept at 1/zoom scale so they come out 1:1
    this.scopeCam.ignore([this.cover,this.scoreText,this.phaseText,this.hpText,this.msgText]);
    this.ring.setScale(1/TUNE.zoom);

    // the enemy snipers — difficulty sets how many hunt you at once
    this.lastPointer = {x: 0, y: 0};
    const slots = Math.min(DIFFS[this.diff].concurrent, TUNE.enemiesPerMap);
    this.spawned = 0; // snipers fielded so far this round (caps at enemiesPerMap)
    this.squadAim = 0; this.nextVolleyAt = 0; // the squad aims and fires as one
    this.enemies = Array.from({length: slots}, () => {
      const e = this.add.image(0,0,'sniper').setDepth(3).setVisible(false);
      e.state = 'down'; e.nextHintAt = 0;
      e.glint = this.add.circle(0,0,4,0xffee66).setDepth(6).setVisible(false);
      this.tweens.add({targets: e.glint, alpha:{from:1,to:0.2}, duration:120, yoyo:true, repeat:-1});
      return e;
    });

    this.input.on('pointerdown', p => {
      if (this.over) {
        if (this.time.now < this.restartOkAt) return; // let the results screen be read
        if (this.cleared) {
          this.scene.restart({phase: (this.phase + 1) % PHASES.length, score: this.score, diff: this.diff});
        } else {
          localStorage.removeItem('sniperDuel'); // death wipes the run
          this.scene.start('menu');
        }
        return;
      }
      if (p.button === 2) this.setScope(true);
      else if (p.button === 0) this.fire(p);
    });
    this.input.on('pointerup', p => { if (p.button === 2) this.setScope(false); });

    for (const e of this.enemies)
      this.time.delayedCall(rand(TUNE.gapMin, TUNE.gapMax), () => this.spawnEnemy(e));
  }

  // procedural skyline: buildings with window grids; every window is a possible hiding spot
  buildCity() {
    this.add.rectangle(WORLD_W/2, H/2, WORLD_W, H, 0x8fa6b8);   // sky
    this.add.rectangle(WORLD_W/2, 500, WORLD_W, 90, 0x3d3d42);  // street
    this.windows = [];
    const shades = [0x5c5650, 0x525660, 0x635a52, 0x4f5358];
    let x = 10, building = 0;
    while (x < WORLD_W - 110) {
      const bw = Phaser.Math.Between(120, 190);
      const bh = Phaser.Math.Between(190, 340);
      const top = 460 - bh;
      this.add.rectangle(x + bw/2, top + bh/2, bw, bh, Phaser.Utils.Array.GetRandom(shades)).setDepth(1);
      for (let wy = top + 26; wy < 430; wy += 46) {
        for (let wx = x + 24; wx < x + bw - 24; wx += 38) {
          const lit = Math.random() < 0.15;
          this.add.rectangle(wx, wy, 24, 32, lit ? 0xc9b46a : 0x14161c).setDepth(2);
          if (!lit) this.windows.push({x: wx, y: wy, building});  // sniper only uses dark windows
        }
      }
      x += bw + Phaser.Math.Between(8, 30);
      building++;
    }
  }

  // a fresh sniper picks any building; a relocating one stays in their building,
  // just a different window (snipers don't teleport across the street)
  spawnEnemy(e, sameBuilding) {
    if (this.over) return;
    if (sameBuilding === undefined) {
      if (this.spawned >= TUNE.enemiesPerMap) return; // squad exhausted for this map
      this.spawned++;
    }
    let pool = this.windows;
    if (sameBuilding !== undefined) {
      pool = this.windows.filter(w => w.building === sameBuilding && !(w.x === e.x && w.y + 2 === e.y));
      if (!pool.length) pool = this.windows;
    }
    // same building is fine, but not the exact same window as a squadmate
    const taken = this.enemies.filter(o => o !== e && o.visible);
    const free = pool.filter(w => !taken.some(o => o.x === w.x && o.y === w.y + 2));
    const w = Phaser.Utils.Array.GetRandom(free.length ? free : pool);
    e.building = w.building;
    e.setPosition(w.x, w.y + 2).setAlpha(0).setVisible(true).clearTint();
    e.state = 'rising';
    e.nextHintAt = this.time.now + 800;
    this.tweens.add({targets: e, alpha: 1, duration: 400, onComplete: () => {
      e.state = 'up';
      e.hideEv = this.time.delayedCall(rand(TUNE.dwellMin, TUNE.dwellMax), () => this.relocate(e));
    }});
  }

  relocate(e) {
    if (e.state !== 'up') return;
    e.state = 'rising'; e.glint.setVisible(false);
    this.tweens.add({targets: e, alpha: 0, duration: 400, onComplete: () => {
      e.state = 'down'; e.setVisible(false);
      this.time.delayedCall(rand(TUNE.gapMin, TUNE.gapMax), () => this.spawnEnemy(e, e.building));
    }});
  }

  setScope(on) {
    if (this.over || on === this.scoped) return;
    this.scoped = on; this.scopedAt = this.time.now;
    // dropping while they're locked on: they fire at your ducking silhouette
    if (!on && this.squadAim > 0.7)
      this.volley(this.enemies.filter(e => e.state === 'up'), false);
    this.scopeCam.setVisible(on); this.ring.setVisible(on);
    this.cross.setScale(on ? 1/TUNE.zoom : 1);
    this.tweens.add({targets: this.cover, y: on ? H+70 : H-60, duration: 150});
  }

  fire(p) {
    if (!this.scoped || this.time.now < this.nextShotAt) return;
    this.nextShotAt = this.time.now + TUNE.boltTime;
    this.shots++; this.updateHud();
    // bolt cycle: reticle drops out and settles back as the action closes
    this.ring.setAlpha(0.25);
    this.tweens.add({targets: this.ring, alpha: 1, duration: TUNE.boltTime, ease: 'Quad.in'});
    this.scopeCam.shake(60, 0.004);
    const wx = p.x + this.cameras.main.scrollX;
    const e = this.enemies.find(o => o.state === 'up' && o.getBounds().contains(wx, p.y));
    if (e) {
      e.hideEv && e.hideEv.remove();
      e.glint.setVisible(false);
      e.setTint(0x883333); e.state = 'dead';
      this.score += DIFFS[this.diff].mult; this.kills++; this.hits++; this.updateHud();
      this.tweens.add({targets: e, alpha: 0, duration: 500, onComplete: () => {
        e.state = 'down'; e.setVisible(false);
        if (this.kills >= TUNE.enemiesPerMap) this.mapClear();
        else this.time.delayedCall(rand(TUNE.gapMin, TUNE.gapMax), () => this.spawnEnemy(e));
      }});
    } else {
      this.puff(wx, p.y);
    }
  }

  // the squad fires as one volley; every active sniper rolls to hit.
  // ducked shots mostly thud into your sandbags — mostly.
  volley(shooters, wasStill) {
    this.squadAim = 0;
    this.nextVolleyAt = this.time.now + TUNE.shotCooldown;
    shooters.forEach(e => e.glint.setVisible(false));
    if (this.over || !shooters.length) return;
    const acc = !this.scoped ? TUNE.coverAccuracy
      : wasStill ? TUNE.botAccuracy : TUNE.botAccuracy * 0.5;
    const hits = shooters.filter(() => Math.random() < acc).length;
    if (hits > 0) {
      this.hp -= hits; this.updateHud();
      this.cameras.main.flash(150, 180, 0, 0);
      if (this.hp <= 0) { this.gameOver(); return; }
    }
    for (let i = hits; i < shooters.length; i++) {
      if (this.scoped) this.cameras.main.shake(80, 0.002); // near miss cracks past
      else this.puff(this.cameras.main.scrollX + rand(100, W-100), H-125); // slug hits sandbags
    }
  }

  accuracy() {
    return this.shots ? `${this.hits}/${this.shots} shots (${Math.round(100*this.hits/this.shots)}%)` : 'no shots fired';
  }

  // map cleared: next round is a fresh city, hours later.
  // round bonuses (not itemized on screen): accuracy and health, difficulty-scaled
  mapClear() {
    this.setScope(false); // before over=true: setScope no-ops once the round is over
    this.over = true; this.cleared = true; this.restartOkAt = this.time.now + 1200;
    const mult = DIFFS[this.diff].mult;
    if (this.shots) this.score += Math.round(5 * (this.hits / this.shots) * mult);
    this.score += this.hp * mult;
    this.updateHud();
    const next = PHASES[(this.phase + 1) % PHASES.length].name;
    this.msgText.setText(`AREA CLEAR — score ${this.score}\naccuracy: ${this.accuracy()}\nclick to move out (${next})`).setVisible(true);
  }

  puff(x, y) {
    const c = this.add.circle(x, y, 5, 0xcccc99).setDepth(55);
    this.tweens.add({targets: c, scale: 2.5, alpha: 0, duration: 300, onComplete: () => c.destroy()});
  }

  // faint periodic lens flash so a patient player can spot the hiding window
  sparkle(x, y) {
    const c = this.add.circle(x, y, 3, 0xddeeff, 0.9).setDepth(6);
    this.tweens.add({targets: c, scale: 2, alpha: 0, duration: 350, onComplete: () => c.destroy()});
  }

  gameOver() {
    this.setScope(false); // before over=true: setScope no-ops once the round is over
    this.over = true; this.restartOkAt = this.time.now + 1200;
    this.squadAim = 0;
    this.enemies.forEach(e => e.glint.setVisible(false));
    this.msgText.setText(`GAME OVER — score ${this.score}\naccuracy: ${this.accuracy()}\nclick for menu`).setVisible(true);
  }

  updateHud() {
    this.scoreText.setText(`Score: ${this.score}   Shots: ${this.shots}`);
    this.phaseText.setText(`${PHASES[this.phase].name} (${DIFFS[this.diff].name}) — ${TUNE.enemiesPerMap - this.kills} left`);
    this.hpText.setText('♥'.repeat(Math.max(0, this.hp)));
  }

  update(time, delta) {
    const p = this.input.activePointer;
    const cam = this.cameras.main;

    // edge panning across the wide city
    if (p.x < TUNE.panEdge) cam.scrollX -= TUNE.panSpeed * delta / 1000;
    else if (p.x > W - TUNE.panEdge) cam.scrollX += TUNE.panSpeed * delta / 1000;

    // reticle and cross live at the pointer's WORLD position: both cameras
    // then map them back to the pointer on screen
    const wx = p.x + cam.scrollX;
    this.cross.setPosition(wx, p.y);
    this.ring.setPosition(wx, p.y);
    this.maskG.setPosition(p.x, p.y); // camera mask is screen-space
    // place the camera so the world point under the crosshair stays under the
    // crosshair after zoom (centerOn would shift it toward screen center)
    this.scopeCam.centerOn(wx - (p.x - W/2)/TUNE.zoom, p.y - (p.y - H/2)/TUNE.zoom);

    const still = Phaser.Math.Distance.Between(wx, p.y, this.lastPointer.x, this.lastPointer.y) < TUNE.stillSpeed;
    this.lastPointer.x = wx; this.lastPointer.y = p.y;

    const up = this.enemies.filter(e => e.state === 'up');
    for (const e of up) {
      if (time > e.nextHintAt) {
        this.sparkle(e.x + 5, e.y - 6);
        e.nextHintAt = time + TUNE.hintEvery;
      }
    }

    // the squad aims together while you're exposed: fast on a still target,
    // slow on a moving one; slowly forgets while you're ducked
    const exposed = up.length > 0 && this.scoped && time > this.scopedAt + TUNE.grace && time > this.nextVolleyAt;
    if (exposed) {
      this.squadAim += (delta / TUNE.aimTime) * (still ? 1 : 0.35);
      this.wasStill = still;
    } else {
      this.squadAim = Math.max(0, this.squadAim - TUNE.aimDrain * delta / 1000);
    }
    // every aiming sniper glints at lock-on: your last window to duck
    for (const e of this.enemies)
      e.glint.setPosition(e.x + 5, e.y - 8).setVisible(e.state === 'up' && exposed && this.squadAim > 0.7);
    if (this.squadAim >= 1) this.volley(up, this.wasStill);
  }
}

new Phaser.Game({type: Phaser.AUTO, parent: 'game', width: W, height: H, backgroundColor: '#111', scene: [MenuScene, DuelScene]});
