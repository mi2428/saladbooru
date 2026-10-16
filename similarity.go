package main

import (
	"fmt"
	"image"
	"image/color"
	"math"
	"math/bits"
	"os"
	"sort"
	"strconv"

	xdraw "golang.org/x/image/draw"
)

const (
	similarDedupeSetting = "SALADBOORU_DEDUPE_SIMILAR"
	pHashDistanceSetting = "SALADBOORU_DEDUPE_PHASH_MAX_DISTANCE"
	dHashDistanceSetting = "SALADBOORU_DEDUPE_DHASH_MAX_DISTANCE"
	ssimSetting          = "SALADBOORU_DEDUPE_SSIM_MIN"

	visualSize = 64
)

type dedupeConfig struct {
	similar          bool
	pHashMaxDistance int
	dHashMaxDistance int
	ssimMin          float64
}

func dedupeConfigFromEnv() (dedupeConfig, error) {
	config := dedupeConfig{pHashMaxDistance: 4, dHashMaxDistance: 4, ssimMin: 0.90}
	var err error
	if value, ok := os.LookupEnv(similarDedupeSetting); ok {
		config.similar, err = strconv.ParseBool(value)
		if err != nil {
			return config, fmt.Errorf("%s must be true or false", similarDedupeSetting)
		}
	}
	for name, target := range map[string]*int{
		pHashDistanceSetting: &config.pHashMaxDistance,
		dHashDistanceSetting: &config.dHashMaxDistance,
	} {
		if value, ok := os.LookupEnv(name); ok {
			*target, err = strconv.Atoi(value)
			if err != nil || *target < 0 || *target > 64 {
				return config, fmt.Errorf("%s must be an integer from 0 to 64", name)
			}
		}
	}
	if value, ok := os.LookupEnv(ssimSetting); ok {
		config.ssimMin, err = strconv.ParseFloat(value, 64)
		if err != nil || math.IsNaN(config.ssimMin) || config.ssimMin < 0 || config.ssimMin > 1 {
			return config, fmt.Errorf("%s must be a number from 0 to 1", ssimSetting)
		}
	}
	return config, nil
}

type visualFingerprint struct {
	pHash uint64
	dHash uint64
	luma  []uint8
}

func fingerprint(source image.Image) visualFingerprint {
	luma := scaledLuma(source, visualSize, visualSize)
	return visualFingerprint{
		pHash: pHash(luma),
		dHash: dHash(scaledLuma(source, 9, 8)),
		luma:  luma,
	}
}

func scaledLuma(source image.Image, width, height int) []uint8 {
	scaled := image.NewNRGBA(image.Rect(0, 0, width, height))
	xdraw.ApproxBiLinear.Scale(scaled, scaled.Bounds(), source, source.Bounds(), xdraw.Src, nil)
	luma := make([]uint8, width*height)
	for y := range height {
		for x := range width {
			pixel := color.NRGBAModel.Convert(scaled.At(x, y)).(color.NRGBA)
			alpha := int(pixel.A)
			r := (int(pixel.R)*alpha + 255*(255-alpha) + 127) / 255
			g := (int(pixel.G)*alpha + 255*(255-alpha) + 127) / 255
			b := (int(pixel.B)*alpha + 255*(255-alpha) + 127) / 255
			luma[y*width+x] = uint8((299*r + 587*g + 114*b + 500) / 1000)
		}
	}
	return luma
}

var dctCosines = func() [8][32]float64 {
	var table [8][32]float64
	for frequency := range table {
		for position := range table[frequency] {
			table[frequency][position] = math.Cos(float64((2*position+1)*frequency) * math.Pi / 64)
		}
	}
	return table
}()

func pHash(luma []uint8) uint64 {
	var pixels [32 * 32]float64
	for y := range 32 {
		for x := range 32 {
			i := y*2*visualSize + x*2
			pixels[y*32+x] = float64(int(luma[i])+int(luma[i+1])+int(luma[i+visualSize])+int(luma[i+visualSize+1])) / 4
		}
	}
	var coefficients [64]float64
	for v := range 8 {
		for u := range 8 {
			var sum float64
			for y := range 32 {
				for x := range 32 {
					sum += pixels[y*32+x] * dctCosines[u][x] * dctCosines[v][y]
				}
			}
			coefficients[v*8+u] = sum
		}
	}
	medianValues := append([]float64(nil), coefficients[1:]...)
	sort.Float64s(medianValues)
	median := medianValues[len(medianValues)/2]
	var hash uint64
	for i, coefficient := range coefficients[1:] {
		if coefficient > median {
			hash |= 1 << i
		}
	}
	return hash
}

func dHash(luma []uint8) uint64 {
	var hash uint64
	for y := range 8 {
		for x := range 8 {
			if luma[y*9+x] > luma[y*9+x+1] {
				hash |= 1 << (y*8 + x)
			}
		}
	}
	return hash
}

func similarity(left, right visualFingerprint, config dedupeConfig) (bool, int, int, float64) {
	pDistance := bits.OnesCount64(left.pHash ^ right.pHash)
	dDistance := bits.OnesCount64(left.dHash ^ right.dHash)
	if pDistance > config.pHashMaxDistance || dDistance > config.dHashMaxDistance {
		return false, pDistance, dDistance, 0
	}
	ssim := structuralSimilarity(left.luma, right.luma)
	return ssim >= config.ssimMin, pDistance, dDistance, ssim
}

func structuralSimilarity(left, right []uint8) float64 {
	const (
		block = 8
		c1    = 6.5025  // (0.01 * 255)^2
		c2    = 58.5225 // (0.03 * 255)^2
	)
	var total float64
	for blockY := 0; blockY < visualSize; blockY += block {
		for blockX := 0; blockX < visualSize; blockX += block {
			var leftMean, rightMean float64
			for y := range block {
				for x := range block {
					i := (blockY+y)*visualSize + blockX + x
					leftMean += float64(left[i])
					rightMean += float64(right[i])
				}
			}
			leftMean /= block * block
			rightMean /= block * block
			var leftVariance, rightVariance, covariance float64
			for y := range block {
				for x := range block {
					i := (blockY+y)*visualSize + blockX + x
					leftDelta := float64(left[i]) - leftMean
					rightDelta := float64(right[i]) - rightMean
					leftVariance += leftDelta * leftDelta
					rightVariance += rightDelta * rightDelta
					covariance += leftDelta * rightDelta
				}
			}
			leftVariance /= block*block - 1
			rightVariance /= block*block - 1
			covariance /= block*block - 1
			total += ((2*leftMean*rightMean + c1) * (2*covariance + c2)) /
				((leftMean*leftMean + rightMean*rightMean + c1) * (leftVariance + rightVariance + c2))
		}
	}
	return total / ((visualSize / block) * (visualSize / block))
}
