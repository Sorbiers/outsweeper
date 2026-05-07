import { Component } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';

@Component({
  selector: 'pp-about-dialog',
  imports: [MatDialogModule, MatButtonModule, MatDividerModule],
  templateUrl: './about-dialog.html',
  styleUrl: './about-dialog.scss',
})
export class AboutDialog {}
