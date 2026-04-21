Add-Type -AssemblyName System.Drawing

$sourcePath = "d:\program\anis 2\icons\source_logo.png"
$outDir = "d:\program\anis 2\icons"
$rootDir = "d:\program\anis 2"

if (-not (Test-Path $sourcePath)) {
    Write-Error "Source logo not found at $sourcePath"
    exit
}

$sourceImg = [System.Drawing.Image]::FromFile($sourcePath)
$sizes = @(72, 96, 128, 144, 152, 192, 384, 512)

foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    
    # Use high quality settings for resizing
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($sourceImg, 0, 0, $size, $size)
    
    $outPath = "$outDir\icon-$size.png"
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $g.Dispose()
    Write-Host "Created: icon-$size.png ($size x $size)"
}

# Create logo.png (using 512x512)
$logoBmp = New-Object System.Drawing.Bitmap(512, 512)
$logoG = [System.Drawing.Graphics]::FromImage($logoBmp)
$logoG.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$logoG.DrawImage($sourceImg, 0, 0, 512, 512)
$logoBmp.Save("$outDir\logo.png", [System.Drawing.Imaging.ImageFormat]::Png)
$logoBmp.Dispose()
$logoG.Dispose()
Write-Host "Created: logo.png (512x512)"

# Create favicon.ico (32x32)
$favBmp = New-Object System.Drawing.Bitmap(32, 32)
$favG = [System.Drawing.Graphics]::FromImage($favBmp)
$favG.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$favG.DrawImage($sourceImg, 0, 0, 32, 32)
$favBmp.Save("$rootDir\favicon.ico", [System.Drawing.Imaging.ImageFormat]::Png)
$favBmp.Dispose()
$favG.Dispose()
Write-Host "Created: favicon.ico (32x32)"

$sourceImg.Dispose()
Write-Host "All icons replaced successfully using the new logo!"
