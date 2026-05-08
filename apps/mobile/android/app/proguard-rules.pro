# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# US-17 — Android Auto (Jetpack Car App library).
# The AA host instantiates `CarAppService` and `Screen` subclasses
# reflectively, so R8 / ProGuard would strip them in release builds and
# the bike display would silently render "Tarmoto stopped responding".
# Keep the package surface and the react-native-carplay native module
# (which provides the concrete subclasses bundled into the app's APK
# via manifest merge — see node_modules/react-native-carplay/android/).
-keep class androidx.car.app.** { *; }
-keep class com.brentvatne.carplay.** { *; }
-dontwarn androidx.car.app.**
