Add-Type -AssemblyName System.Drawing

$sizes = @(72, 96, 128, 144, 152, 192, 384, 512)
$outDir = "d:\program\anis 2\icons"

foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

    # Background dark
    $bgColor = [System.Drawing.Color]::FromArgb(255, 10, 13, 20)
    $bgBrush = New-Object System.Drawing.SolidBrush($bgColor)
    $g.FillRectangle($bgBrush, 0, 0, $size, $size)

    # Gold color
    $goldColor = [System.Drawing.Color]::FromArgb(255, 251, 191, 36)
    $goldBrush = New-Object System.Drawing.SolidBrush($goldColor)
    $goldPenW = [float]([math]::Max(2, $size * 0.035))
    $goldPen = New-Object System.Drawing.Pen($goldColor, $goldPenW)

    # Factory dimensions
    $cx   = [float]($size / 2)
    $topY = [float]($size * 0.22)
    $baseY= [float]($size * 0.75)
    $bw   = [float]($size * 0.62)
    $bh   = [float]($baseY - $topY)

    # Main building body
    $bodyRect = New-Object System.Drawing.RectangleF(($cx - $bw/2), $topY, $bw, $bh)
    $g.DrawRectangle($goldPen, $bodyRect.X, $bodyRect.Y, $bodyRect.Width, $bodyRect.Height)

    # Chimney left
    $chW = [float]($size * 0.09)
    $chH = [float]($size * 0.15)
    $chX = [float]($cx - $bw/2 + $size * 0.07)
    $chY = [float]($topY - $chH)
    $g.FillRectangle($goldBrush, $chX, $chY, $chW, $chH)

    # Chimney right
    $ch2X = [float]($cx + $bw/2 - $size * 0.07 - $chW)
    $g.FillRectangle($goldBrush, $ch2X, $chY, $chW, $chH)

    # Door
    $dW = [float]($size * 0.16)
    $dH = [float]($size * 0.22)
    $dX = [float]($cx - $dW / 2)
    $dY = [float]($baseY - $dH)
    $g.DrawRectangle($goldPen, $dX, $dY, $dW, $dH)

    # Window left
    $wSz = [float]($size * 0.10)
    $wY  = [float]($topY + $size * 0.09)
    $wX1 = [float]($cx - $bw/2 + $size * 0.08)
    $g.FillRectangle($goldBrush, $wX1, $wY, $wSz, $wSz)

    # Window right
    $wX2 = [float]($cx + $bw/2 - $size * 0.08 - $wSz)
    $g.FillRectangle($goldBrush, $wX2, $wY, $wSz, $wSz)

    # Bottom label "Z"
    $fontSize = [float]([math]::Max(8, $size * 0.14))
    $font = New-Object System.Drawing.Font("Arial", $fontSize, [System.Drawing.FontStyle]::Bold)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $labelBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(220, 251, 191, 36))
    $g.DrawString("Z", $font, $labelBrush, $cx, [float]($baseY + $size * 0.11), $sf)

    $g.Dispose()
    $outPath = "$outDir\icon-$size.png"
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "Created: icon-$size.png"
}

Write-Host "All icons created successfully!"
