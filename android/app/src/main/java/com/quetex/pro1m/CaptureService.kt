package com.quetex.pro1m

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Base64
import android.util.DisplayMetrics
import android.view.WindowManager
import android.webkit.WebView
import androidx.core.app.NotificationCompat
import java.io.ByteArrayOutputStream

/**
 * Foreground service that mirrors the screen and pushes a JPEG frame into the
 * WebView every few seconds:
 *
 *   MediaProjection → ImageReader → JPEG → base64 → window.QP.onFrame(...)
 *
 * Android 14 (API 34) requirements implemented here:
 *   - service declared/started with FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
 *   - MediaProjection.Callback registered before createVirtualDisplay()
 */
class CaptureService : Service() {

    companion object {
        private const val CHANNEL_ID = "qp_capture"
        private const val NOTIFICATION_ID = 42
        private const val INTERVAL_MS = 6_000L
        private const val MAX_WIDTH = 1280

        @Volatile var isRunning: Boolean = false
            private set

        @Volatile private var webView: WebView? = null

        fun attach(view: WebView) { webView = view }

        fun start(context: Context, resultCode: Int, data: Intent, view: WebView) {
            attach(view)
            val intent = Intent(context, CaptureService::class.java).apply {
                putExtra("resultCode", resultCode)
                putExtra("resultData", data)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, CaptureService::class.java))
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var projection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var screenWidth = 1080
    private var screenHeight = 1920
    private var screenDensity = 420

    private val captureLoop = object : Runnable {
        override fun run() {
            try {
                captureFrame()
            } catch (_: Throwable) {
                // never let a bad frame kill the loop
            }
            handler.postDelayed(this, INTERVAL_MS)
        }
    }

    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            cleanup()
        }
    }

    override fun onCreate() {
        super.onCreate()
        createChannel()
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        isRunning = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "STOP") {
            cleanup()
            return START_NOT_STICKY
        }
        val resultCode = intent?.getIntExtra("resultCode", Activity.RESULT_CANCELED)
            ?: Activity.RESULT_CANCELED
        @Suppress("DEPRECATION")
        val resultData: Intent? = intent?.getParcelableExtra("resultData")

        if (resultCode != Activity.RESULT_OK || resultData == null) {
            cleanup()
            return START_NOT_STICKY
        }
        startProjection(resultCode, resultData)
        return START_NOT_STICKY
    }

    /* --------------------------- projection --------------------------- */

    @Suppress("DEPRECATION")
    private fun startProjection(resultCode: Int, resultData: Intent) {
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        projection = manager.getMediaProjection(resultCode, resultData)

        val metrics = DisplayMetrics()
        (getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(metrics)
        screenWidth = metrics.widthPixels
        screenHeight = metrics.heightPixels
        screenDensity = metrics.densityDpi

        projection?.registerCallback(projectionCallback, handler)

        reader = ImageReader.newInstance(screenWidth, screenHeight, PixelFormat.RGBA_8888, 2)

        virtualDisplay = projection?.createVirtualDisplay(
            "quetex-capture",
            screenWidth,
            screenHeight,
            screenDensity,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader?.surface,
            null,
            handler
        )

        handler.postDelayed(captureLoop, 1_500L) // give the mirror a moment to settle
    }

    private fun captureFrame() {
        val image = reader?.acquireLatestImage() ?: return
        var bitmap: Bitmap? = null
        var scaled: Bitmap? = null
        try {
            val plane = image.planes[0]
            val pixelStride = plane.pixelStride
            val rowStride = plane.rowStride
            val rowPadding = rowStride - pixelStride * image.width

            val padded = Bitmap.createBitmap(
                image.width + rowPadding / pixelStride,
                image.height,
                Bitmap.Config.ARGB_8888
            )
            padded.copyPixelsFromBuffer(plane.buffer)
            bitmap = if (rowPadding > 0) {
                Bitmap.createBitmap(padded, 0, 0, image.width, image.height)
            } else {
                padded
            }
            if (bitmap !== padded) padded.recycle()

            val scale = MAX_WIDTH.toFloat() / bitmap.width
            scaled = if (scale < 1f) {
                Bitmap.createScaledBitmap(
                    bitmap,
                    (bitmap.width * scale).toInt().coerceAtLeast(1),
                    (bitmap.height * scale).toInt().coerceAtLeast(1),
                    true
                )
            } else {
                bitmap
            }

            val out = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, 70, out)
            val base64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
            val js = "window.QP && window.QP.onFrame('data:image/jpeg;base64,$base64');"

            webView?.post { webView?.evaluateJavascript(js, null) }
        } finally {
            if (scaled != null && scaled !== bitmap) scaled.recycle()
            bitmap?.recycle()
            image.close()
        }
    }

    /* ----------------------------- lifecycle ----------------------------- */

    private fun cleanup() {
        handler.removeCallbacks(captureLoop)
        try { virtualDisplay?.release() } catch (_: Throwable) {}
        virtualDisplay = null
        try { reader?.close() } catch (_: Throwable) {}
        reader = null
        try { projection?.unregisterCallback(projectionCallback) } catch (_: Throwable) {}
        try { projection?.stop() } catch (_: Throwable) {}
        projection = null
        isRunning = false
        stopForeground(true)
        stopSelf()
    }

    override fun onDestroy() {
        cleanup()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /* ---------------------------- notification ---------------------------- */

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Screen capture",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Reads your chart while Quetex is analysing"
            setShowBadge(false)
        }
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, CaptureService::class.java).apply { action = "STOP" },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.notif_title))
            .setContentText(getString(R.string.notif_text))
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(0, getString(R.string.stop_capture), stop)
            .build()
    }
}
