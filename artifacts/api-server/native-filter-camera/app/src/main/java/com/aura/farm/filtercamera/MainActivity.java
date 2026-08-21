package com.aura.farm.filtercamera;

import android.Manifest;
import android.content.ContentValues;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.annotation.NonNull;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.face.Face;
import com.google.mlkit.vision.face.FaceDetection;
import com.google.mlkit.vision.face.FaceDetector;
import com.google.mlkit.vision.face.FaceDetectorOptions;

import java.io.OutputStream;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Native CameraX filter surface. Camera frames never leave the device. */
public final class MainActivity extends ComponentActivity {
    private static final int CAMERA_REQUEST = 42;
    private PreviewView preview;
    private FilterOverlay overlay;
    private ExecutorService cameraExecutor;
    private FaceDetector detector;
    private String filter = "Off";
    private TextView status;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        cameraExecutor = Executors.newSingleThreadExecutor();
        FaceDetectorOptions options = new FaceDetectorOptions.Builder()
                .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
                .setLandmarkMode(FaceDetectorOptions.LANDMARK_MODE_ALL)
                .enableTracking().build();
        detector = FaceDetection.getClient(options);
        buildUi();
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.CAMERA}, CAMERA_REQUEST);
        } else startCamera();
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.BLACK);
        preview = new PreviewView(this);
        preview.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);
        overlay = new FilterOverlay(this);
        android.widget.FrameLayout cameraBox = new android.widget.FrameLayout(this);
        cameraBox.addView(preview, new android.widget.FrameLayout.LayoutParams(-1, -1));
        cameraBox.addView(overlay, new android.widget.FrameLayout.LayoutParams(-1, -1));
        root.addView(cameraBox, new LinearLayout.LayoutParams(-1, 0, 1));

        status = new TextView(this);
        status.setTextColor(Color.WHITE); status.setText("Native camera · face tracking ready");
        status.setGravity(Gravity.CENTER); status.setPadding(8, 8, 8, 8);
        root.addView(status, new LinearLayout.LayoutParams(-1, 42));

        LinearLayout controls = new LinearLayout(this);
        controls.setGravity(Gravity.CENTER); controls.setPadding(8, 8, 8, 12);
        String[] names = {"Off", "Glasses", "Beard", "Blush", "Freckles", "Cartoon"};
        for (String name : names) {
            TextView b = button(name);
            controls.addView(b, new LinearLayout.LayoutParams(0, 52, 1));
        }
        TextView capture = button("Capture");
        capture.setOnClickListener(v -> captureFilteredFrame());
        controls.addView(capture, new LinearLayout.LayoutParams(0, 52, 1.2f));
        root.addView(controls);
        setContentView(root);
    }

    private TextView button(String text) {
        TextView b = new TextView(this);
        b.setText(text); b.setTextColor(Color.WHITE); b.setGravity(Gravity.CENTER);
        b.setTextSize(11); b.setOnClickListener(v -> {
            filter = text; overlay.invalidate();
            status.setText("Filter: " + filter + " · Face tracking stays on-device");
        });
        return b;
    }

    private void startCamera() {
        ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(this);
        future.addListener(() -> {
            try {
                ProcessCameraProvider provider = future.get();
                Preview cameraPreview = new Preview.Builder().build();
                cameraPreview.setSurfaceProvider(preview.getSurfaceProvider());
                ImageAnalysis analysis = new ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build();
                analysis.setAnalyzer(cameraExecutor, image -> {
                    InputImage input = InputImage.fromMediaImage(image.getImage(),
                            image.getImageInfo().getRotationDegrees());
                    detector.process(input).addOnSuccessListener(faces -> runOnUiThread(() -> {
                        overlay.setFaces(faces);
                        status.setText(faces.isEmpty()
                                ? "Filter: " + filter + " · Show a face to the camera"
                                : "Filter: " + filter + " · Face tracked");
                    })).addOnCompleteListener(done -> image.close());
                });
                provider.unbindAll();
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_FRONT_CAMERA, cameraPreview, analysis);
            } catch (Exception e) { status.setText("Camera unavailable: " + e.getMessage()); }
        }, ContextCompat.getMainExecutor(this));
    }

    private void captureFilteredFrame() {
        Bitmap source = preview.getBitmap();
        if (source == null) { Toast.makeText(this, "Camera preview is not ready", Toast.LENGTH_SHORT).show(); return; }
        Bitmap result = source.copy(Bitmap.Config.ARGB_8888, true);
        Canvas canvas = new Canvas(result);
        overlay.drawFilter(canvas, result.getWidth(), result.getHeight());
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, "AuraFilter_" + System.currentTimeMillis() + ".jpg");
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
        values.put(MediaStore.Images.Media.RELATIVE_PATH, "DCIM/AuraFilters");
        Uri uri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        try (OutputStream out = uri == null ? null : getContentResolver().openOutputStream(uri)) {
            if (out == null || !result.compress(Bitmap.CompressFormat.JPEG, 95, out)) throw new Exception("save failed");
            Toast.makeText(this, "Filtered photo saved to DCIM/AuraFilters", Toast.LENGTH_SHORT).show();
        } catch (Exception e) { if (uri != null) getContentResolver().delete(uri, null, null); Toast.makeText(this, e.getMessage(), Toast.LENGTH_SHORT).show(); }
    }

    @Override protected void onDestroy() {
        super.onDestroy(); if (cameraExecutor != null) cameraExecutor.shutdown(); if (detector != null) detector.close();
    }

    private final class FilterOverlay extends View {
        private List<Face> faces = Collections.emptyList();
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        FilterOverlay(android.content.Context context) { super(context); paint.setStrokeWidth(6); setWillNotDraw(false); }
        void setFaces(List<Face> value) { faces = value == null ? Collections.emptyList() : value; invalidate(); }
        @Override protected void onDraw(Canvas canvas) { super.onDraw(canvas); drawFilter(canvas, getWidth(), getHeight()); }
        void drawFilter(Canvas canvas, int width, int height) {
            if ("Off".equals(filter)) return;
            paint.setStyle(Paint.Style.STROKE); paint.setColor(Color.WHITE);
            for (Face face : faces) {
                Rect r = face.getBoundingBox();
                float sx = width / (float) Math.max(1, preview.getWidth());
                float sy = height / (float) Math.max(1, preview.getHeight());
                float left = width - r.right * sx, right = width - r.left * sx;
                float top = r.top * sy, bottom = r.bottom * sy;
                float cx = (left + right) / 2f, cy = (top + bottom) / 2f;
                float w = right - left;
                if ("Glasses".equals(filter)) { canvas.drawOval(left + w*.05f, cy-w*.12f, cx-w*.04f, cy+w*.03f, paint); canvas.drawOval(cx+w*.04f, cy-w*.12f, right-w*.05f, cy+w*.03f, paint); canvas.drawLine(cx-w*.05f, cy-w*.04f, cx+w*.05f, cy-w*.04f, paint); }
                if ("Beard".equals(filter)) { paint.setStyle(Paint.Style.FILL); paint.setColor(0xAA3B2418); canvas.drawOval(left+w*.25f, cy+w*.12f, right-w*.25f, bottom-w*.03f, paint); }
                if ("Blush".equals(filter)) { paint.setColor(0x88FF5C87); canvas.drawCircle(left+w*.18f, cy+w*.08f, w*.09f, paint); canvas.drawCircle(right-w*.18f, cy+w*.08f, w*.09f, paint); }
                if ("Freckles".equals(filter)) { paint.setColor(0xFFFFB07C); for (int i=0;i<8;i++) canvas.drawCircle(left+w*(.25f+(i%4)*.16f), cy+w*(.04f+(i/4)*.08f), 4, paint); }
                if ("Cartoon".equals(filter)) { paint.setStyle(Paint.Style.STROKE); paint.setColor(Color.YELLOW); paint.setStrokeWidth(10); canvas.drawOval(left-w*.05f, top-w*.05f, right+w*.05f, bottom+w*.05f, paint); }
            }
        }
    }
}