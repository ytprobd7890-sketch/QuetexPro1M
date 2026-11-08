package com.quetex.pro1m

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

/**
 * Quetex 1M — Android capture shell.
 *
 * Loads the web terminal in a WebView and, on request, starts a foreground
 * MediaProjection service that pushes screen frames into `window.QP.onFrame()`.
 * That removes the "screenshot → share → crop" loop entirely.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var captureButton: Button
    private val prefs by lazy { getSharedPreferences("qp", Context.MODE_PRIVATE) }
    private val projectionManager by lazy {
        getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
    }

    private val captureLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val data = result.data
        if (result.resultCode == Activity.RESULT_OK && data != null) {
            CaptureService.start(this, result.resultCode, data, webView)
            Toast.makeText(this, R.string.capture_started, Toast.LENGTH_SHORT).show()
            setCapturing(true)
        } else {
            Toast.makeText(this, R.string.capture_denied, Toast.LENGTH_SHORT).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildUi()
        loadAppUrl()
    }

    /* ------------------------------ UI ------------------------------ */

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF05080C.toInt())
        }

        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(24, 24, 24, 24)
            setBackgroundColor(0xFF0B1118.toInt())
        }

        val title = TextView(this).apply {
            text = "Quetex 1M"
            setTextColor(0xFFE6EDF3.toInt())
            textSize = 15f
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }

        captureButton = Button(this).apply {
            text = getString(R.string.start_capture)
            setOnClickListener { toggleCapture() }
        }

        val urlButton = Button(this).apply {
            text = "URL"
            setOnClickListener { promptForUrl() }
        }

        bar.addView(title)
        bar.addView(captureButton)
        bar.addView(urlButton)

        webView = WebView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f
            )
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.loadWithOverviewMode = true
            settings.useWideViewPort = true
            webChromeClient = WebChromeClient()
            webViewClient = WebViewClient()
            setBackgroundColor(0xFF05080C.toInt())
        }

        root.addView(bar)
        root.addView(webView)
        setContentView(root)
    }

    private fun setCapturing(on: Boolean) {
        captureButton.text = getString(if (on) R.string.stop_capture else R.string.start_capture)
    }

    /* ------------------------------ URL ------------------------------ */

    private fun currentUrl(): String {
        val saved = prefs.getString("url", null)
        if (!saved.isNullOrBlank()) return saved
        return BuildConfig.APP_URL
    }

    private fun loadAppUrl() {
        val url = currentUrl()
        if (url.contains("your-quetex-host")) {
            promptForUrl()
        } else {
            webView.loadUrl(url)
        }
    }

    private fun promptForUrl() {
        val input = EditText(this).apply {
            setText(if (currentUrl().contains("your-quetex-host")) "" else currentUrl())
            hint = "https://…"
            inputType = InputType.TYPE_TEXT_VARIATION_URI
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.url_title)
            .setMessage(R.string.url_message)
            .setView(input)
            .setPositiveButton(R.string.load) { _, _ ->
                val url = input.text.toString().trim()
                if (url.startsWith("http://") || url.startsWith("https://")) {
                    prefs.edit().putString("url", url).apply()
                    webView.loadUrl(url)
                } else {
                    Toast.makeText(this, R.string.url_invalid, Toast.LENGTH_SHORT).show()
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    /* ---------------------------- capture ---------------------------- */

    private fun toggleCapture() {
        if (CaptureService.isRunning) {
            CaptureService.stop(this)
            setCapturing(false)
            return
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7)
        }

        val intent = projectionManager.createScreenCaptureIntent()
        captureLauncher.launch(intent)
    }

    override fun onResume() {
        super.onResume()
        setCapturing(CaptureService.isRunning)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        CaptureService.stop(this)
        webView.destroy()
        super.onDestroy()
    }
}
