// Dibujado WebGL2 sin librerías. Los modelos del MU usan Z hacia arriba.
'use strict';

class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: false });
    if (!gl) throw new Error('Tu navegador no soporta WebGL2.');
    this.gl = gl;
    this.prog = this.makeProgram(
      `#version 300 es
       in vec3 aPos; in vec3 aNrm; in vec2 aUV;
       uniform mat4 uMVP;
       out vec3 vN; out vec2 vUV;
       void main() { vN = aNrm; vUV = aUV; gl_Position = uMVP * vec4(aPos, 1.0); }`,
      `#version 300 es
       precision highp float;
       in vec3 vN; in vec2 vUV;
       uniform sampler2D uTex; uniform float uAlphaTest; uniform int uLit; uniform vec3 uLight; uniform vec4 uTint;
       out vec4 o;
       void main() {
         vec4 c = texture(uTex, vUV) * uTint;
         if (c.a < uAlphaTest) discard;
         float l = 1.0;
         if (uLit == 1) l = 0.5 + 0.65 * abs(dot(normalize(vN), uLight));
         o = vec4(c.rgb * l, c.a);
       }`);
    this.u = {};
    for (const n of ['uMVP', 'uTex', 'uAlphaTest', 'uLit', 'uLight', 'uTint']) this.u[n] = gl.getUniformLocation(this.prog, n);
    this.white = this.makeSolidTexture([255, 255, 255, 255]);
    this.missing = this.makeCheckerTexture();
    this.parts = [];
    this.bg = [0.17, 0.19, 0.22];
    this.lit = true;
    this.textured = true;
    this.cam = { yaw: -Math.PI / 2, pitch: 0.25, dist: 300, target: [0, 0, 0] };
    this.home = null;
    this.dirty = true;
    this.bindInput();
    new ResizeObserver(() => { this.dirty = true; }).observe(canvas);
  }

  makeProgram(vs, fs) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos'); gl.bindAttribLocation(p, 1, 'aNrm'); gl.bindAttribLocation(p, 2, 'aUV');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  makeSolidTexture(rgba) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
    return t;
  }

  makeCheckerTexture() {
    const gl = this.gl, t = gl.createTexture(), px = new Uint8Array(8 * 8 * 4);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const o = (y * 8 + x) * 4, on = (x + y) & 1;
      px.set(on ? [230, 60, 200, 255] : [60, 60, 70, 255], o);
    }
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 8, 8, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return t;
  }

  uploadTexture(tex) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (tex.pixels) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tex.pw, tex.ph, 0, gl.RGBA, gl.UNSIGNED_BYTE, tex.pixels);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tex.canvas);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    return t;
  }

  // ----- Modelo -----

  clear() {
    const gl = this.gl;
    for (const p of this.parts) {
      gl.deleteBuffer(p.posBuf); gl.deleteBuffer(p.nrmBuf); gl.deleteBuffer(p.uvBuf); gl.deleteVertexArray(p.vao);
      if (p.glTex) gl.deleteTexture(p.glTex);
    }
    this.parts = [];
    this.model = null;
    this.dirty = true;
  }

  setModel(model) {
    this.clear();
    this.model = model;
    const gl = this.gl;
    let badIndex = false;
    for (const m of model.meshes) {
      const corners = [];
      for (const t of m.tris) {
        const order = t.poly === 4 ? [0, 1, 2, 0, 2, 3] : [0, 1, 2];
        for (const k of order) {
          let v = t.v[k], n = t.n[k], u = t.t[k];
          if (v < 0 || v >= m.nv) { v = 0; badIndex = true; }
          if (n < 0 || n >= m.nn) { n = -1; }
          if (u < 0 || u >= m.nt) { u = -1; badIndex = true; }
          corners.push(v, n, u);
        }
      }
      const count = corners.length / 3;
      const uv = new Float32Array(count * 2);
      for (let i = 0; i < count; i++) {
        const u = corners[i * 3 + 2];
        if (u >= 0) { uv[i * 2] = m.uv[u * 2]; uv[i * 2 + 1] = m.uv[u * 2 + 1]; }
      }
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const posBuf = gl.createBuffer(), nrmBuf = gl.createBuffer(), uvBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.bufferData(gl.ARRAY_BUFFER, count * 12, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf); gl.bufferData(gl.ARRAY_BUFFER, count * 12, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf); gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      this.parts.push({
        mesh: m, corners: new Int32Array(corners), count, vao, posBuf, nrmBuf, uvBuf,
        pos: new Float32Array(count * 3), nrm: new Float32Array(count * 3),
        glTex: null, state: 'loading', hasAlpha: false, visible: true, blend: 'auto',
      });
    }
    return { badIndex };
  }

  setTexture(i, tex) {
    const p = this.parts[i];
    if (!p) return;
    if (p.glTex) this.gl.deleteTexture(p.glTex);
    if (tex) { p.glTex = this.uploadTexture(tex); p.hasAlpha = tex.hasAlpha; p.state = 'ok'; }
    else { p.glTex = null; p.state = 'missing'; }
    this.dirty = true;
  }

  // Aplica las matrices de huesos a los vértices (como BMD::Transform del cliente).
  pose(mats) {
    const gl = this.gl;
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const p of this.parts) {
      const m = p.mesh;
      const vp = new Float32Array(m.nv * 3), np = new Float32Array(m.nn * 3);
      for (let i = 0; i < m.nv; i++) {
        const M = mats[m.vNode[i]] || MU.IDENTITY;
        const x = m.vPos[i * 3], y = m.vPos[i * 3 + 1], z = m.vPos[i * 3 + 2];
        vp[i * 3] = M[0] * x + M[1] * y + M[2] * z + M[3];
        vp[i * 3 + 1] = M[4] * x + M[5] * y + M[6] * z + M[7];
        vp[i * 3 + 2] = M[8] * x + M[9] * y + M[10] * z + M[11];
      }
      for (let i = 0; i < m.nn; i++) {
        const M = mats[m.nNode[i]] || MU.IDENTITY;
        const x = m.nVec[i * 3], y = m.nVec[i * 3 + 1], z = m.nVec[i * 3 + 2];
        np[i * 3] = M[0] * x + M[1] * y + M[2] * z;
        np[i * 3 + 1] = M[4] * x + M[5] * y + M[6] * z;
        np[i * 3 + 2] = M[8] * x + M[9] * y + M[10] * z;
      }
      const c = p.corners;
      for (let i = 0; i < p.count; i++) {
        const v = c[i * 3] * 3, n = c[i * 3 + 1];
        p.pos[i * 3] = vp[v]; p.pos[i * 3 + 1] = vp[v + 1]; p.pos[i * 3 + 2] = vp[v + 2];
        if (n >= 0) { p.nrm[i * 3] = np[n * 3]; p.nrm[i * 3 + 1] = np[n * 3 + 1]; p.nrm[i * 3 + 2] = np[n * 3 + 2]; }
        else { p.nrm[i * 3] = 0; p.nrm[i * 3 + 1] = 0; p.nrm[i * 3 + 2] = 1; }
      }
      if (p.visible) {
        for (let i = 0; i < p.count; i++) for (let k = 0; k < 3; k++) {
          const val = p.pos[i * 3 + k];
          if (val < box[k]) box[k] = val;
          if (val > box[k + 3]) box[k + 3] = val;
        }
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, p.posBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, p.pos);
      gl.bindBuffer(gl.ARRAY_BUFFER, p.nrmBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, p.nrm);
    }
    this.dirty = true;
    return box;
  }

  frameBox(box) {
    if (!isFinite(box[0])) return;
    const c = [(box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2];
    const r = Math.max(1, Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]) / 2);
    this.home = { target: c, dist: r * 2.6 };
    this.resetView();
  }

  resetView() {
    if (!this.home) return;
    this.cam.target = this.home.target.slice();
    this.cam.dist = this.home.dist;
    this.cam.yaw = -Math.PI / 2;
    this.cam.pitch = 0.2;
    this.dirty = true;
  }

  // ----- Cámara -----

  eye() {
    const { yaw, pitch, dist, target } = this.cam;
    return [target[0] + dist * Math.cos(pitch) * Math.cos(yaw), target[1] + dist * Math.cos(pitch) * Math.sin(yaw), target[2] + dist * Math.sin(pitch)];
  }

  bindInput() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('pointerdown', e => {
      c.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.button === 1 || e.shiftKey };
    });
    c.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) {
        const s = this.cam.dist * 0.0018;
        const { yaw, pitch } = this.cam;
        const right = [-Math.sin(yaw), Math.cos(yaw), 0];
        const up = [-Math.sin(pitch) * Math.cos(yaw), -Math.sin(pitch) * Math.sin(yaw), Math.cos(pitch)];
        for (let k = 0; k < 3; k++) this.cam.target[k] += (-dx * right[k] + dy * up[k]) * s;
      } else {
        this.cam.yaw -= dx * 0.01;
        this.cam.pitch = Math.max(-1.55, Math.min(1.55, this.cam.pitch + dy * 0.01));
      }
      this.dirty = true;
    });
    const end = () => { drag = null; };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', e => {
      e.preventDefault();
      this.cam.dist *= Math.exp(e.deltaY * 0.0012);
      this.dirty = true;
    }, { passive: false });
    c.addEventListener('dblclick', () => this.resetView());
  }

  // ----- Dibujo -----

  draw() {
    const gl = this.gl, c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clearColor(this.bg[0], this.bg[1], this.bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.parts.length) { this.dirty = false; return; }

    const eye = this.eye();
    const d = this.cam.dist;
    const mvp = mul4(perspective(Math.PI / 4, w / h, d / 200, d * 50), lookAt(eye, this.cam.target, [0, 0, 1]));
    const light = norm3([eye[0] - this.cam.target[0] + d * 0.3, eye[1] - this.cam.target[1], eye[2] - this.cam.target[2] + d * 0.6]);

    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.u.uMVP, false, mvp);
    gl.uniform3fv(this.u.uLight, light);
    gl.uniform1i(this.u.uLit, this.lit ? 1 : 0);
    gl.uniform1i(this.u.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    const modeOf = p => {
      if (p.blend !== 'auto') return p.blend;
      if (!this.textured) return 'opaco';
      if (p.hasAlpha) return 'alpha';
      if (p.glTex && (p.autoAdd || this.jpgBright)) return 'aditivo';
      return 'opaco';
    };
    const passes = ['opaco', 'alpha', 'aditivo'];
    for (const pass of passes) {
      for (const p of this.parts) {
        if (!p.visible || modeOf(p) !== pass) continue;
        const tex = !this.textured ? this.white : p.glTex || (p.state === 'missing' ? this.missing : this.white);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform4fv(this.u.uTint, !this.textured ? [0.78, 0.8, 0.84, 1] : [1, 1, 1, 1]);
        if (pass === 'opaco') {
          gl.disable(gl.BLEND); gl.depthMask(true); gl.uniform1f(this.u.uAlphaTest, -1);
        } else if (pass === 'alpha') {
          gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(true); gl.uniform1f(this.u.uAlphaTest, 0.1);
        } else {
          gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.depthMask(false); gl.uniform1f(this.u.uAlphaTest, -1);
        }
        gl.bindVertexArray(p.vao);
        gl.drawArrays(gl.TRIANGLES, 0, p.count);
      }
    }
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    this.dirty = false;
  }
}

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}
function norm3(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function lookAt(eye, center, up) {
  const z = norm3([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
  const x = norm3(cross(up, z)), y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
}
function mul4(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
