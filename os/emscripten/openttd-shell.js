      /* EduCraft: dotykove ovladani.
       *
       * OpenTTD pocita s mysi a prave tlacitko pouziva na bourani a na napovedu
       * k prvkum rozhrani. Dotykovy displej zadne prave tlacitko nema a nativni
       * emulace v OpenTTD existuje jen pro macOS, takze ji tady poskladame sami:
       * dlouhy stisk na miste = prave kliknuti.
       *
       * Posun mapy resi nastaveni scroll_mode = MapLMB (tah prstem), takze tady
       * staci pokryt prave tlacitko.
       */
      (function () {
        var canvas = document.getElementById('canvas');
        if (!canvas || !('ontouchstart' in window)) return;

        var PRODLEVA_MS = 500;
        var TOLERANCE_PX = 12;

        var casovac = null;
        var start = null;
        var vystrelil = false;

        function mysNa(typ, x, y) {
          canvas.dispatchEvent(new MouseEvent(typ, {
            bubbles: true, cancelable: true, view: window,
            clientX: x, clientY: y, button: 2, buttons: typ === 'mouseup' ? 0 : 2
          }));
        }

        function zrus() {
          if (casovac !== null) { clearTimeout(casovac); casovac = null; }
        }

        canvas.addEventListener('touchstart', function (e) {
          if (e.touches.length !== 1) { zrus(); return; }
          var t = e.touches[0];
          start = { x: t.clientX, y: t.clientY };
          vystrelil = false;
          zrus();
          casovac = setTimeout(function () {
            casovac = null;
            vystrelil = true;
            mysNa('mousedown', start.x, start.y);
            mysNa('mouseup', start.x, start.y);
          }, PRODLEVA_MS);
        }, { passive: true });

        canvas.addEventListener('touchmove', function (e) {
          if (!start || e.touches.length !== 1) { zrus(); return; }
          var t = e.touches[0];
          /* Tah je posun mapy, ne prave kliknuti — jakmile se prst hne, cekani rusime. */
          if (Math.abs(t.clientX - start.x) > TOLERANCE_PX ||
              Math.abs(t.clientY - start.y) > TOLERANCE_PX) zrus();
        }, { passive: true });

        canvas.addEventListener('touchend', function (e) {
          zrus();
          /* Kdyz uz prave kliknuti probehlo, nesmi za nim prijit jeste leve —
           * jinak by dlouhy stisk udelal oboji. */
          if (vystrelil) { e.preventDefault(); vystrelil = false; }
        }, { passive: false });

        canvas.addEventListener('touchcancel', zrus, { passive: true });
      })();

      /* EduCraft: drive inline oncontextmenu na <canvas>; inline handlery
         blokuje CSP stejne jako inline <script>. */
      document.getElementById('canvas')
        .addEventListener('contextmenu', function (e) { e.preventDefault(); });

      var statusElement = document.getElementById('status');
      var progressElement = document.getElementById('progress');
      var spinnerElement = document.getElementById('spinner');

      var Module = {
        preRun: [],
        postRun: [],
        arguments: [],
        totalDependencies: 42,
        doneDependencies: 0,
        lastDependencies: 1,

        print: function(text) {
            if (arguments.length > 1) text = Array.prototype.slice.call(arguments).join(' ');
            console.log(text);
        },

        printErr: function(text) {
            if (arguments.length > 1) text = Array.prototype.slice.call(arguments).join(' ');
            console.error(text);
        },

        canvas: (function() {
          var canvas = document.getElementById('canvas');

          // As a default initial behavior, pop up an alert when webgl context is lost. To make your
          // application robust, you may want to override this behavior before shipping!
          // See http://www.khronos.org/registry/webgl/specs/latest/1.0/#5.15.2
          canvas.addEventListener("webglcontextlost", function(e) { alert('WebGL context lost. You will need to reload the page.'); e.preventDefault(); }, false);

          return canvas;
        })(),

        setStatus: function(text) {
          if (document.getElementById("canvas").style.display == "none") return;

          var m = text.match(/^([^(]+)\((\d+(\.\d+)?)\/(\d+)\)$/);

          if (m) {
            text = "(" + m[2] + " / " + m[4] + ") " + m[1];
          }

          document.getElementById("message").innerHTML = text;
        },

        monitorRunDependencies: function(left) {
          /* If it goes up, a new dependency was added; down means one is
           * removed. We only track the latter. */
          if (left < Module.lastDependencies) {
            Module.doneDependencies += 1;
          }
          Module.lastDependencies = left;

          total = Module.totalDependencies;
          doing = Module.doneDependencies + 1;
          if (doing > total) {
            doing = total;
          }

          document.getElementById("title").innerHTML = "(" + doing + " / " + total + ") Loading ...";
          document.getElementById("message").innerHTML = "Preparing game ...";
        },

        onBootstrap: function(current, total) {
          document.getElementById("canvas").style.display = "none";

          document.getElementById("title").innerHTML = "Missing base graphics";
          document.getElementById("message").innerHTML = "OpenTTD is downloading base graphics.<br/><br/>" + current + " / " + total + " bytes downloaded.";
        },

        onBootstrapFailed: function(current, total) {
          document.getElementById("canvas").style.display = "none";

          document.getElementById("title").innerHTML = "Missing base graphics";
          document.getElementById("message").innerHTML = "Failed to download base graphics.<br/>The game cannot start without base graphics.<br/><br/>Please check your Internet connection and/or the console log.<br/>Reload your browser to try again.";
        },

        onBootstrapReload: function() {
          document.getElementById("canvas").style.display = "none";

          document.getElementById("title").innerHTML = "Missing base graphics";
          document.getElementById("message").innerHTML = "Downloading base graphics done.<br/><br/>Your browser will reload to start the game.";
        },

        onExit: function() {
          document.getElementById("canvas").style.display = "none";

          document.getElementById("title").innerHTML = "Thank you for playing!";
          document.getElementById("message").innerHTML = "We hope you enjoyed OpenTTD!<br/><br/>Reload your browser to restart the game.";
        },

        onAbort: function() {
          document.getElementById("canvas").style.display = "none";

          document.getElementById("box").className = "error";
          document.getElementById("title").innerHTML = "Crash :(";
          document.getElementById("message").innerHTML = "The game crashed!<br/><br/>Please reload your browser to restart the game.";
        },

        onWarningFs: function() {
          document.getElementById("filesystem").style.display = "inline-block";
          document.getElementById("overlay").style.opacity = 1;
          setTimeout(function() {
            document.getElementById("overlay").style.opacity = 0;
            setTimeout(function() {
              document.getElementById("filesystem").style.display = "none";
            }, 300);
          }, 10000);
        }
      };

      window.onerror = function() {
        Module.onAbort();
      };
