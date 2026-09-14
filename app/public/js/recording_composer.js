/* ============================================================================
 * RegiMath — Compositor de Gravação de Aulas
 * ----------------------------------------------------------------------------
 * Gera a gravação final (1280x720, 16:9) desenhando os streams dos
 * participantes em um canvas. A gravação final deixa de depender das
 * proporções da câmera de cada dispositivo.
 *
 * Funcionalidades:
 *  - Enquadramento automático (detecta vertical/horizontal pelas dimensões
 *    reais do vídeo e preserva a proporção — sem esticar/deformar).
 *  - Layout profissional: faixa com identidade visual RegiMath, tiles dos
 *    participantes com nome/regra e plano de fundo desfocado.
 *  - Mix de áudio via Web Audio API (microfone local + áudio remoto).
 *  - A chamada continua usando a qualidade adaptativa da WebRTC; esta
 *    composição é apenas para o arquivo final de gravação.
 *
 * Uso (browser):
 *   const composer = new RegiMathRecordingComposer({
 *     canvasWidth: 1280, canvasHeight: 720,
 *     participants: [ { key, name, role, getVideoEl } ]
 *   });
 *   const streamFinal = composer.createComposedStream([localStream, remoteStream]);
 *   ... gravar o streamFinal com MediaRecorder/RecordRTC ...
 *   composer.replaceAudioStream(streamAntigo, streamNovo); // troca de mic/tela
 *   composer.stop();                                        // ao encerrar
 * ==========================================================================*/
(function (global) {
    'use strict';
  
    var PALETTE = {
      bgTop: '#2b0f18',
      bgBottom: '#120509',
      panelBorder: 'rgba(232,174,30,0.45)',
      accent: '#E8AE1E',
      headerStart: '#5f0018',
      headerEnd: '#800020',
      text: '#ffffff',
      textDim: 'rgba(255,255,255,0.78)',
      recRed: '#e53935'
    };
  
    var HEADER_H = 60;
    var FOOTER_H = 34;
  
    /* ------------------------------------------------------------------ *
     * Funções puras (testáveis em Node)
     * ------------------------------------------------------------------ */
  
    /**
     * Retorna o retângulo CONTIDO (preserva 100% da imagem, sem cortes)
     * para desenhar um vídeo `srcW x srcH` dentro da área `dstW x dstH`.
     */
    function regimathContainRect(srcW, srcH, dstW, dstH) {
      var scale = Math.min(dstW / srcW, dstH / srcH);
      var w = srcW * scale;
      var h = srcH * scale;
      return { x: (dstW - w) / 2, y: (dstH - h) / 2, w: w, h: h, scale: scale };
    }
  
    /**
     * Retângulo COBERTURA (usado apenas para o fundo desfocado do tile).
     */
    function regimathCoverRect(srcW, srcH, dstW, dstH) {
      var scale = Math.max(dstW / srcW, dstH / srcH);
      var w = srcW * scale;
      var h = srcH * scale;
      return { x: (dstW - w) / 2, y: (dstH - h) / 2, w: w, h: h, scale: scale };
    }
  
    /**
     * Calcula o layout da composição (1280x720 por padrão).
     *
     * @param {Array} participants - lista de participantes.
     * @param {number} canvasW - largura do canvas (ex.: 1280).
     * @param {number} canvasH - altura do canvas (ex.: 720).
     * @param {Object} [opts]
     * @returns {{tiles: Array<{x:number,y:number,w:number,h:number}>}}
     */
    function regimathComputeLayout(participants, canvasW, canvasH, opts) {
      var options = opts || {};
      var headerH = options.headerH || HEADER_H;
      var footerH = options.footerH || FOOTER_H;
      var padding = options.padding || 24;
      var gap = options.gap || 16;
  
      var n = Array.isArray(participants) ? participants.length : 0;
  
      var contentX = padding;
      var contentTop = headerH + padding;
      var contentW = canvasW - padding * 2;
      var contentH = canvasH - headerH - footerH - padding * 2;
  
      var tiles = [];
  
      if (n === 1) {
        // Participante único: tile centralizado em proporção 16:9.
        var panelW = Math.min(contentW, contentH * (16 / 9));
        var panelH = panelW * (9 / 16);
        tiles.push({
          x: contentX + (contentW - panelW) / 2,
          y: contentTop + (contentH - panelH) / 2,
          w: panelW,
          h: panelH
        });
      } else if (n > 1) {
        // Grid de tiles iguais (lado a lado para 2 participantes).
        var cols = n === 2 ? 2 : Math.min(n, 3);
        var rows = Math.ceil(n / cols);
        var tileW = (contentW - gap * (cols - 1)) / cols;
        var tileH = (contentH - gap * (rows - 1)) / rows;
  
        for (var i = 0; i < n; i++) {
          var col = i % cols;
          var row = Math.floor(i / cols);
          tiles.push({
            x: contentX + col * (tileW + gap),
            y: contentTop + row * (tileH + gap),
            w: tileW,
            h: tileH
          });
        }
      }
  
      return {
        header: { h: headerH },
        footer: { h: footerH },
        content: {
          x: contentX,
          y: contentTop,
          w: contentW,
          h: contentH
        },
        tiles: tiles
      };
    }
  /* ------------------------------------------------------------------ *
     * Helpers de desenho
     * ------------------------------------------------------------------ */
  
    function roundRectPath(ctx, x, y, w, h, r) {
      var radius = Math.max(0, Math.min(r, w / 2, h / 2));
      if (typeof ctx.roundRect === 'function') {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, radius);
        ctx.closePath();
        return;
      }
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.arcTo(x + w, y, x + w, y + h, radius);
      ctx.arcTo(x + w, y + h, x, y + h, radius);
      ctx.arcTo(x, y + h, x, y, radius);
      ctx.arcTo(x, y, x + w, y, radius);
      ctx.closePath();
    }
  
    function truncateText(ctx, text, maxWidth) {
      var value = String(text);
      if (ctx.measureText(value).width <= maxWidth) return value;
      var ellipsis = '…';
      while (value.length > 1 && ctx.measureText(value + ellipsis).width > maxWidth) {
        value = value.slice(0, -1);
      }
      return value + ellipsis;
    }
  
    function formatClock(ms) {
      var totalSeconds = Math.floor(ms / 1000);
      var m = Math.floor(totalSeconds / 60);
      var s = totalSeconds % 60;
      return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }
  
    function getInitials(name) {
      var words = String(name || '?').trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) return '?';
      var initials = words[0].charAt(0);
      if (words.length > 1) initials += words[words.length - 1].charAt(0);
      return initials.toUpperCase();
    }
  
    function canvasSupportsBlur(ctx) {
      // ctx.filter existe no Chrome/Edge/Firefox e no Safari recente.
      return typeof ctx.filter === 'string';
    }
  
    /* ------------------------------------------------------------------ *
     * Compositor
     * ------------------------------------------------------------------ */
  
    function RegiMathRecordingComposer(options) {
      var opts = options || {};
  
      this.width = opts.canvasWidth || 1280;
      this.height = opts.canvasHeight || 720;
      this.showNames = opts.showNames !== false;
      this.brandText = opts.brandText || 'RegiMath';
  
      this.participants = (opts.participants || []).map(function (p, i) {
        return {
          key: p.key || 'participante-' + i,
          name: typeof p.name === 'string' ? p.name : (opts.fallbackName || 'Participante'),
          role: p.role || '',
          isLocal: !!p.isLocal,
          getVideoEl: typeof p.getVideoEl === 'function' ? p.getVideoEl : function () { return null; }
        };
      });
  
      if (typeof document !== 'undefined') {
        this.canvas = document.createElement('canvas');
        this.canvas.width = this.width;
        this.canvas.height = this.height;
        this.ctx = this.canvas.getContext('2d', { alpha: false });
      } else {
        this.canvas = null;
        this.ctx = null;
      }
  
      this.running = false;
      this.startTime = 0;
      this.rafId = null;
  
      // Áudio
      this.audioCtx = null;
      this.audioDest = null;
      this.audioSources = new Map(); // stream -> { source, gain }
      this.canvasStream = null;
      this.composedStream = null;
  
      // Cache do fundo desfocado (evita blur caro em todos os frames).
      this._bgCache = null;
  
      this._audioResumeHandler = function () {
        if (this.audioCtx && this.audioCtx.state === 'suspended') {
          this.audioCtx.resume().catch(function () {});
        }
      }.bind(this);
    }
  
    RegiMathRecordingComposer.prototype.getComposedStream = function () {
      return this.composedStream || null;
    };
  
  /**
     * Cria o stream final da gravação: vídeo do canvas + áudio mixado
     * (local + remoto) por meio do AudioContext.
     */
    RegiMathRecordingComposer.prototype.createComposedStream = function (audioStreams) {
      // Em ambientes sem MediaStream (ex.: testes Node), expõe um objeto
      // mínimo compatível para que o contrato público continue testável.
      var MS = (typeof window !== 'undefined' && window.MediaStream) ||
               (typeof MediaStream !== 'undefined' ? MediaStream : null);
      var AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
  
      if (!MS) {
        var emptyStream = {
          __regimathStub: true,
          getVideoTracks: function () { return []; },
          getAudioTracks: function () { return []; },
          getTracks: function () { return []; },
          addTrack: function () {},
          removeTrack: function () {}
        };
        this.composedStream = emptyStream; // stub p/ testes
        return emptyStream;
      }
  
      if (this.ctx) {
        this.canvasStream = this.canvas.captureStream(24);
        this._startRenderLoop();
      }
  
      var combinedAudioTracks = [];
  
      if (AC && Array.isArray(audioStreams)) {
        this.audioCtx = new AC();
        this.audioDest = this.audioCtx.createMediaStreamDestination();
  
        var self = this;
        audioStreams.forEach(function (stream) {
          self._connectAudioSource(stream);
        });
  
        combinedAudioTracks = this.audioDest.stream.getAudioTracks();
  
        if (typeof window !== 'undefined') {
          window.addEventListener('pointerdown', this._audioResumeHandler, true);
          window.addEventListener('keydown', this._audioResumeHandler, true);
        }
        // Navegadores podem exigir gesto do usuário; tenta retomar agora.
        if (this.audioCtx.state === 'suspended') {
          this.audioCtx.resume().catch(function () {});
        }
      }
  
      var finalStream;
      if (this.canvasStream && this.canvasStream.getVideoTracks().length > 0) {
        finalStream = new MediaStream([
          this.canvasStream.getVideoTracks()[0],
          combinedAudioTracks[0] || null
        ].filter(Boolean));
      } else if (combinedAudioTracks.length > 0) {
        finalStream = new MediaStream(combinedAudioTracks.slice());
      } else {
        finalStream = new MediaStream();
      }
      this.composedStream = finalStream;
      return finalStream;
    };
  
    RegiMathRecordingComposer.prototype._connectAudioSource = function (stream) {
      if (!stream || !this.audioCtx || !this.audioDest) return;
      var audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) return;
      if (this.audioSources.has(stream)) return;
  
      var src = this.audioCtx.createMediaStreamSource(new MediaStream(audioTracks));
      // Ganho uniforme — ambos os participantes ficam audíveis.
      var gain = this.audioCtx.createGain();
      gain.gain.value = 1.0;
      src.connect(gain);
      gain.connect(this.audioDest);
  
      this.audioSources.set(stream, { source: src, gain: gain });
    };
  
    /**
     * Reconfigura a entrada de áudio quando o stream local muda
     * (ex.: alternar para compartilhamento de tela e voltar).
     */
    RegiMathRecordingComposer.prototype.replaceAudioStream = function (oldStream, newStream) {
      if (!this.audioCtx) return;
      var entry = this.audioSources.get(oldStream);
      if (entry) {
        try {
          entry.source.disconnect();
          entry.gain.disconnect();
        } catch (e) { /* já desconectado */ }
        this.audioSources.delete(oldStream);
      }
      this._connectAudioSource(newStream);
    };
  
    RegiMathRecordingComposer.prototype._startRenderLoop = function () {
      if (this.running) return;
      this.running = true;
      this.startTime = performance.now();
  
      var self = this;
      function frame() {
        if (!self.running) return;
        self._draw();
        self.rafId = requestAnimationFrame(frame);
      }
      this.rafId = requestAnimationFrame(frame);
    };
  
    RegiMathRecordingComposer.prototype.stop = function () {
      this.running = false;
      this.composedStream = null;
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
  
      if (this.canvasStream) {
        this.canvasStream.getTracks().forEach(function (t) { t.stop(); });
        this.canvasStream = null;
      }
  
      if (this.audioCtx) {
        if (typeof window !== 'undefined') {
          window.removeEventListener('pointerdown', this._audioResumeHandler, true);
          window.removeEventListener('keydown', this._audioResumeHandler, true);
        }
        var self = this;
        this.audioSources.forEach(function (entry) {
          try { entry.source.disconnect(); } catch (e) { /* noop */ }
          try { entry.gain.disconnect(); } catch (e) { /* noop */ }
        });
        this.audioSources.clear();
        try { this.audioCtx.close(); } catch (e) { /* already closed */ }
        this.composedStream = null;
        this.audioCtx = null;
        this.audioDest = null;
      }
  
      this._bgCache = null;
    };
  /* ------------------------------------------------------------------ *
     * Desenho
     * ------------------------------------------------------------------ */
  
    RegiMathRecordingComposer.prototype._draw = function () {
      var ctx = this.ctx;
      if (!ctx) return;
  
      var W = this.width;
      var H = this.height;
  
      // Fundo principal.
      var bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, PALETTE.bgTop);
      bg.addColorStop(1, PALETTE.bgBottom);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
  
      this._drawHeader(ctx, W);
      this._drawFooter(ctx, W);
  
      var layout = regimathComputeLayout(this.participants, W, H);
      for (var i = 0; i < layout.tiles.length; i++) {
        this._drawTile(ctx, layout.tiles[i], this.participants[i]);
      }
    };
  
    RegiMathRecordingComposer.prototype._drawHeader = function (ctx, W) {
      ctx.save();
      var grad = ctx.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, PALETTE.headerStart);
      grad.addColorStop(1, PALETTE.headerEnd);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, HEADER_H);
  
      ctx.fillStyle = PALETTE.accent;
      ctx.font = '700 27px Poppins, Arial, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.brandText, 24, HEADER_H / 2);
  
      ctx.font = '400 13px Poppins, Arial, sans-serif';
      ctx.fillStyle = PALETTE.textDim;
      ctx.fillText('', 132, HEADER_H / 2);
  
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '500 15px Poppins, Arial, sans-serif';
      ctx.fillText(new Date().toLocaleDateString('pt-BR'), W - 24, HEADER_H / 2);
      ctx.textAlign = 'left';
      ctx.restore();
    };
  
    RegiMathRecordingComposer.prototype._drawFooter = function (ctx, W) {
      var y = this.height - FOOTER_H;
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(0, y, W, FOOTER_H);
      ctx.strokeStyle = 'rgba(232,174,30,0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(W, y + 0.5);
      ctx.stroke();
  
      ctx.textBaseline = 'middle';
      ctx.fillStyle = PALETTE.recRed;
      ctx.font = '700 12px Poppins, Arial, sans-serif';
      ctx.fillText('●', 17, y + FOOTER_H / 2 - 1);
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = '400 12px Poppins, Arial, sans-serif';
      ctx.fillText('  REC', 31, y + FOOTER_H / 2);
  
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText(formatClock(performance.now() - this.startTime) + '', W - 24, y + FOOTER_H / 2);
      ctx.textAlign = 'left';
      ctx.restore();
    };
  
    RegiMathRecordingComposer.prototype._getVideoState = function (videoEl) {
      if (!videoEl) return { ready: false, w: 0, h: 0 };
      var vw = videoEl.videoWidth || 0;
      var vh = videoEl.videoHeight || 0;
      var liveTrack = null;
      try {
        var so = videoEl.srcObject;
        if (so && typeof so.getVideoTracks === 'function') {
          var vts = so.getVideoTracks();
          liveTrack = vts && vts.length ? vts[0] : null;
        }
      } catch (e) { liveTrack = null; }
      var camOff = !!liveTrack && liveTrack.enabled === false;
      if (vw > 0 && vh > 0 && !videoEl.paused && !camOff) {
        return { ready: true, w: vw, h: vh };
      }
      return { ready: false, w: 0, h: 0 };
    };
  
    RegiMathRecordingComposer.prototype._renderBlurredBackground = function (videoEl, state, tile) {
      // Fundo desfocado: vídeo em modo cobertura, borrado, escurecido.
      var bw = Math.round(tile.w);
      var bh = Math.round(tile.h);
      var off = document.createElement('canvas');
      off.width = bw;
      off.height = bh;
      var octx = off.getContext('2d');
  
      var cover = regimathCoverRect(state.w, state.h, bw, bh);
  
      if (canvasSupportsBlur(octx)) {
        octx.save();
        octx.filter = 'blur(18px) brightness(0.7)';
        octx.drawImage(videoEl, cover.x, cover.y, cover.w, cover.h);
        octx.restore();
      } else {
        octx.globalAlpha = 0.22;
        octx.drawImage(videoEl, cover.x, cover.y, cover.w, cover.h);
        octx.globalAlpha = 1;
      }
  
      // Escurece levemente para dar contraste ao vídeo nítido sobreposto.
      octx.fillStyle = 'rgba(0,0,0,0.20)';
      octx.fillRect(0, 0, bw, bh);
  
      return off;
    };
  RegiMathRecordingComposer.prototype._drawTile = function (ctx, tile, participant) {
      ctx.save();
  
      // Tile com cantos arredondados.
      roundRectPath(ctx, tile.x, tile.y, tile.w, tile.h, 14);
      ctx.clip();
  
      var videoEl = participant.getVideoEl();
      var state = this._getVideoState(videoEl);
      var now = performance.now();
  
      // Fundo desfocado com cache (~1 atualização a cada 300ms).
      var sizeKey = Math.round(tile.w) + 'x' + Math.round(tile.h) + '@' + state.w + 'x' + state.h;
      var cached = this._bgCache;
      if (state.ready && cached &&
          cached.owner === participant.key &&
          cached.sizeKey === sizeKey &&
          (now - cached.at < 300)) {
        ctx.drawImage(cached.canvas, tile.x, tile.y, tile.w, tile.h);
      } else {
        if (state.ready) {
          var bgCanvas = this._renderBlurredBackground(videoEl, state, tile);
          this._bgCache = { owner: participant.key, sizeKey: sizeKey, at: now, canvas: bgCanvas };
          ctx.drawImage(bgCanvas, tile.x, tile.y, tile.w, tile.h);
        } else {
          var grad = ctx.createLinearGradient(0, tile.y, 0, tile.y + tile.h);
          grad.addColorStop(0, 'rgba(38,14,24,0.95)');
          grad.addColorStop(1, 'rgba(18,7,12,0.95)');
          ctx.fillStyle = grad;
          ctx.fillRect(tile.x, tile.y, tile.w, tile.h);
        }
      }
  
      if (state.ready) {
        // Vídeo NÍTIDO em modo CONTAIN — preserva a proporção e o enquadramento
        // originais da câmera, sem esticar e sem cortar o participante.
        var fit = regimathContainRect(state.w, state.h, tile.w, tile.h);
        ctx.drawImage(videoEl, tile.x + fit.x, tile.y + fit.y, fit.w, fit.h);
      } else {
        this._drawPlaceholder(ctx, tile, participant);
      }
  
      // Borda sutil.
      ctx.strokeStyle = PALETTE.panelBorder;
      ctx.lineWidth = 2;
      ctx.strokeRect(tile.x + 1, tile.y + 1, tile.w - 2, tile.h - 2);
  
      ctx.restore();
  
      // Faixa de identificação.
      if (this.showNames) {
        this._drawNameBadge(ctx, tile, participant);
      }
    };
  RegiMathRecordingComposer.prototype._drawPlaceholder = function (ctx, tile, participant) {
      var cx = tile.x + tile.w / 2;
      var cy = tile.y + tile.h / 2;
  
      ctx.save();
      ctx.fillStyle = 'rgba(232,174,30,0.16)';
      ctx.beginPath();
      ctx.arc(cx, cy - 14, 46, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = PALETTE.accent;
      ctx.lineWidth = 2;
      ctx.stroke();
  
      ctx.fillStyle = PALETTE.accent;
      ctx.font = '700 40px Poppins, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(getInitials(participant.name), cx, cy - 14);
  
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = '400 14px Poppins, Arial, sans-serif';
      ctx.fillText('Câmera desligada', cx, cy + 44);
      ctx.textAlign = 'left';
      ctx.restore();
    };
  
    RegiMathRecordingComposer.prototype._drawNameBadge = function (ctx, tile, participant) {
      if (!participant.name) return;
  
      var barH = 56;
      var by = tile.y + tile.h - barH;
  
      ctx.save();
      var grad = ctx.createLinearGradient(0, by, 0, by + barH);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(0,0,0,0.8)');
      ctx.fillStyle = grad;
      ctx.fillRect(tile.x, by, tile.w, barH);
  
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
  
      if (participant.role) {
        ctx.fillStyle = PALETTE.accent;
        ctx.font = '600 11px Poppins, Arial, sans-serif';
        ctx.fillText(String(participant.role).toUpperCase(), tile.x + 14, by + 22);
      }
  
      ctx.fillStyle = PALETTE.text;
      ctx.font = '600 18px Poppins, Arial, sans-serif';
      ctx.fillText(
        truncateText(ctx, participant.name, tile.w - 28),
        tile.x + 14,
        by + 44
      );
      ctx.restore();
    };
  
    /* ------------------------------------------------------------------ *
     * Exportações (browser global + Node para testes)
     * ------------------------------------------------------------------ */
  
    var exported = {
      RegiMathRecordingComposer: RegiMathRecordingComposer,
      regimathComputeLayout: regimathComputeLayout,
      regimathContainRect: regimathContainRect,
      regimathCoverRect: regimathCoverRect
    };
  
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = exported;
    } else {
      global.RegiMathRecordingComposer = RegiMathRecordingComposer;
      global.regimathComputeLayout = regimathComputeLayout;
      global.regimathContainRect = regimathContainRect;
      global.regimathCoverRect = regimathCoverRect;
    }
  })(typeof window !== 'undefined' ? window : globalThis);