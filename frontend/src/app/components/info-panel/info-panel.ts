import { Component, Input } from '@angular/core';
import { DatePipe, KeyValuePipe } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { MatChipsModule } from '@angular/material/chips';
import { PhotoInfo } from '../../models/photo.model';

@Component({
  selector: 'pp-info-panel',
  imports: [DatePipe, KeyValuePipe, MatCardModule, MatDividerModule, MatChipsModule],
  templateUrl: './info-panel.html',
  styleUrl: './info-panel.scss',
})
export class InfoPanel {
  @Input() info: PhotoInfo | null = null;
}
