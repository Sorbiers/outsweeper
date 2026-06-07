import { Component, EventEmitter, inject, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { ComfyConnectionService } from '../../services/comfy-connection.service';

@Component({
  selector: 'pp-comfy-url-row',
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatIconModule],
  templateUrl: './comfy-url-row.html',
  styleUrl: './comfy-url-row.scss',
})
export class ComfyUrlRowComponent {
  @Output() connected = new EventEmitter<void>();
  comfy = inject(ComfyConnectionService);

  checkConnection(): void {
    this.comfy.checkConnection(() => this.connected.emit());
  }
}
