package app.tarmoto

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.common.assets.ReactFontManager
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          // add(MyReactNativePackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    // Register the brand font families so Android resolves the intermediate
    // weights (500/600, plus mono 800) to their dedicated faces. RN's filename
    // convention only auto-resolves Regular/Bold from assets/fonts; the
    // res/font XML families carry every weight, and ReactFontManager applies
    // the requested fontWeight (Typeface.create(family, weight) on API 28+).
    ReactFontManager.getInstance().addCustomFont(this, "SpaceGrotesk", R.font.spacegrotesk)
    ReactFontManager.getInstance().addCustomFont(this, "JetBrainsMono", R.font.jetbrainsmono)
    loadReactNative(this)
  }
}
