import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  inject,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import * as THREE from 'three';
import { PhotoInfo } from '../../models/photo.model';
import { PhotoService } from '../../services/photo.service';

const ZOOM_STEP = 1.15;
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 20;

const SPHERE_FOV_MIN = 20;
const SPHERE_FOV_MAX = 120;
const SPHERE_FOV_DEFAULT = 75;

@Component({
  selector: 'pp-preview-panel',
  templateUrl: './preview-panel.html',
  styleUrl: './preview-panel.scss',
  imports: [MatButtonModule, MatProgressSpinnerModule],
})
export class PreviewPanel implements OnChanges, OnDestroy {
  @Input() info: PhotoInfo | null = null;
  @Input() folder = 'source';
  @ViewChild('container') containerRef!: ElementRef<HTMLDivElement>;
  @ViewChild('img') imgRef!: ElementRef<HTMLImageElement>;

  zoomMode: 'fit' | 'free' | 'sphere' = 'fit';
  zoomLevel = 1;

  private photoService = inject(PhotoService);
  private cdr = inject(ChangeDetectorRef);
  private panning = false;
  private panStartX = 0;
  private panStartY = 0;
  private scrollStartX = 0;
  private scrollStartY = 0;
  private boundPanMove = (e: MouseEvent) => this.onPanMove(e);
  private boundPanEnd = () => this.onPanEnd();

  // Sphere view state
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private sphereMesh: THREE.Mesh | null = null;
  private sphereTexture: THREE.Texture | null = null;
  private animFrameId = 0;
  private sphereDragging = false;
  private sphereLastX = 0;
  private sphereLastY = 0;
  private sphereLon = 0;
  private sphereLat = 0;
  private resizeObserver: ResizeObserver | null = null;
  private boundSphereMouseDown = (e: MouseEvent) => this.onSphereMouseDown(e);
  private boundSphereMouseMove = (e: MouseEvent) => this.onSphereMouseMove(e);
  private boundSphereMouseUp = () => this.onSphereMouseUp();
  private boundSphereWheel = (e: WheelEvent) => this.onSphereWheel(e);

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['info']) {
      this.disposeSphere();
      this.zoomMode = 'fit';
      this.zoomLevel = 1;
    }
  }

  ngOnDestroy(): void {
    this.disposeSphere();
  }

  get imageUrl(): string | null {
    return this.info ? this.photoService.getImageUrl(this.info.filename, this.folder) : null;
  }

  setFit() {
    this.disposeSphere();
    this.zoomMode = 'fit';
    this.zoomLevel = 1;
  }

  setFull() {
    this.disposeSphere();
    this.zoomMode = 'free';
    this.zoomLevel = 1;
  }

  setSphere() {
    this.zoomMode = 'sphere';
    this.cdr.detectChanges(); // Force Angular to render the canvas now
    this.initSphere();
  }

  get isFull(): boolean {
    return this.zoomMode === 'free' && this.zoomLevel === 1;
  }

  get scaledWidth(): number {
    const img = this.imgRef?.nativeElement;
    return img ? img.naturalWidth * this.zoomLevel : 0;
  }

  get scaledHeight(): number {
    const img = this.imgRef?.nativeElement;
    return img ? img.naturalHeight * this.zoomLevel : 0;
  }

  onWheel(event: WheelEvent) {
    if (this.zoomMode === 'sphere') return;
    event.preventDefault();
    const container = this.containerRef?.nativeElement;
    const img = this.imgRef?.nativeElement;
    if (!container || !img) return;

    if (this.zoomMode === 'fit') {
      const fitScale = Math.min(
        container.clientWidth / img.naturalWidth,
        container.clientHeight / img.naturalHeight,
        1,
      );
      this.zoomLevel = fitScale;
      this.zoomMode = 'free';
    }

    const oldZoom = this.zoomLevel;
    const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    this.zoomLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, oldZoom * factor));

    const rect = container.getBoundingClientRect();
    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;

    const scrollX = container.scrollLeft;
    const scrollY = container.scrollTop;

    const ratio = this.zoomLevel / oldZoom;

    requestAnimationFrame(() => {
      container.scrollLeft = (scrollX + cursorX) * ratio - cursorX;
      container.scrollTop = (scrollY + cursorY) * ratio - cursorY;
    });
  }

  onPanStart(event: MouseEvent) {
    if (this.zoomMode === 'fit' || this.zoomMode === 'sphere') return;
    const container = this.containerRef?.nativeElement;
    if (!container) return;
    if (
      container.scrollWidth <= container.clientWidth &&
      container.scrollHeight <= container.clientHeight
    )
      return;
    event.preventDefault();
    this.panning = true;
    this.panStartX = event.clientX;
    this.panStartY = event.clientY;
    this.scrollStartX = container.scrollLeft;
    this.scrollStartY = container.scrollTop;
    document.addEventListener('mousemove', this.boundPanMove);
    document.addEventListener('mouseup', this.boundPanEnd);
  }

  private onPanMove(event: MouseEvent) {
    if (!this.panning) return;
    const container = this.containerRef?.nativeElement;
    if (!container) return;
    container.scrollLeft = this.scrollStartX - (event.clientX - this.panStartX);
    container.scrollTop = this.scrollStartY - (event.clientY - this.panStartY);
  }

  private onPanEnd() {
    this.panning = false;
    document.removeEventListener('mousemove', this.boundPanMove);
    document.removeEventListener('mouseup', this.boundPanEnd);
  }

  // --- Sphere view ---

  private initSphere() {
    const container = this.containerRef?.nativeElement;
    const canvas = container?.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas || !container || !this.imageUrl) return;

    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) {
      // Container not laid out yet, retry
      requestAnimationFrame(() => this.initSphere());
      return;
    }

    this.sphereLon = 0;
    this.sphereLat = 0;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(w, h);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      SPHERE_FOV_DEFAULT,
      container.clientWidth / container.clientHeight,
      0.1,
      1000,
    );

    const geometry = new THREE.SphereGeometry(500, 64, 32);
    geometry.scale(-1, 1, 1); // invert so texture faces inward

    const loader = new THREE.TextureLoader();
    this.sphereTexture = loader.load(this.imageUrl, () => {
      this.renderSphere();
    });
    this.sphereTexture.colorSpace = THREE.SRGBColorSpace;

    const material = new THREE.MeshBasicMaterial({ map: this.sphereTexture });
    this.sphereMesh = new THREE.Mesh(geometry, material);
    this.scene.add(this.sphereMesh);

    // Event listeners on canvas
    canvas.addEventListener('mousedown', this.boundSphereMouseDown);
    canvas.addEventListener('wheel', this.boundSphereWheel, { passive: false });
    document.addEventListener('mousemove', this.boundSphereMouseMove);
    document.addEventListener('mouseup', this.boundSphereMouseUp);

    // Resize handling
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.renderer || !this.camera || !container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderSphere();
    });
    this.resizeObserver.observe(container);

    this.renderSphere();
  }

  private renderSphere() {
    if (!this.renderer || !this.scene || !this.camera) return;

    const phi = THREE.MathUtils.degToRad(90 - this.sphereLat);
    const theta = THREE.MathUtils.degToRad(this.sphereLon);

    const target = new THREE.Vector3(
      500 * Math.sin(phi) * Math.cos(theta),
      500 * Math.cos(phi),
      500 * Math.sin(phi) * Math.sin(theta),
    );
    this.camera.lookAt(target);
    this.renderer.render(this.scene, this.camera);
  }

  private onSphereMouseDown(e: MouseEvent) {
    e.preventDefault();
    this.sphereDragging = true;
    this.sphereLastX = e.clientX;
    this.sphereLastY = e.clientY;
  }

  private onSphereMouseMove(e: MouseEvent) {
    if (!this.sphereDragging) return;
    const dx = e.clientX - this.sphereLastX;
    const dy = e.clientY - this.sphereLastY;
    this.sphereLastX = e.clientX;
    this.sphereLastY = e.clientY;

    // Scale rotation speed by current FOV for consistent feel
    const fovScale = (this.camera?.fov ?? SPHERE_FOV_DEFAULT) / SPHERE_FOV_DEFAULT;
    this.sphereLon -= dx * 0.2 * fovScale;
    this.sphereLat += dy * 0.2 * fovScale;
    this.sphereLat = Math.max(-85, Math.min(85, this.sphereLat));

    this.renderSphere();
  }

  private onSphereMouseUp() {
    this.sphereDragging = false;
  }

  private onSphereWheel(e: WheelEvent) {
    e.preventDefault();
    if (!this.camera) return;
    const fov = this.camera.fov + (e.deltaY > 0 ? 3 : -3);
    this.camera.fov = Math.max(SPHERE_FOV_MIN, Math.min(SPHERE_FOV_MAX, fov));
    this.camera.updateProjectionMatrix();
    this.renderSphere();
  }

  private disposeSphere() {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = 0;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    const container = this.containerRef?.nativeElement;
    const canvas = container?.querySelector('canvas');
    if (canvas) {
      canvas.removeEventListener('mousedown', this.boundSphereMouseDown);
      canvas.removeEventListener('wheel', this.boundSphereWheel);
    }
    document.removeEventListener('mousemove', this.boundSphereMouseMove);
    document.removeEventListener('mouseup', this.boundSphereMouseUp);
    if (this.sphereTexture) {
      this.sphereTexture.dispose();
      this.sphereTexture = null;
    }
    if (this.sphereMesh) {
      (this.sphereMesh.material as THREE.MeshBasicMaterial).dispose();
      this.sphereMesh.geometry.dispose();
      this.sphereMesh = null;
    }
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }
    this.scene = null;
    this.camera = null;
  }

  onImageLoad(info: PhotoInfo | null): void {
    if (info) {
      info.loaded = true;
    }
  }
}
