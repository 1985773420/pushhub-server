package com.pushhub.app;

import com.journeyapps.barcodescanner.CaptureActivity;
import com.journeyapps.barcodescanner.DecoratedBarcodeView;

/** Dedicated portrait QR capture, independent of ZXing's landscape default. */
public final class PairCaptureActivity extends CaptureActivity {
    @Override protected DecoratedBarcodeView initializeContent() {
        setContentView(R.layout.activity_pair_capture);
        return findViewById(com.google.zxing.client.android.R.id.zxing_barcode_scanner);
    }
}
