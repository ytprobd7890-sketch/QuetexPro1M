# Quetex 1M — minification is off for this app (isMinifyEnabled = false),
# so this file only documents intent for anyone who turns R8 on later.

# The WebView bridge is called by name from JavaScript strings; keep it if you shrink.
-keepclassmembers class com.quetex.pro1m.** { *; }
-keep class com.quetex.pro1m.BuildConfig { *; }
