(function () {

	'use strict';
	angular.module('landcoverportal')
	.filter('treeCanopyHeightYearRange', function () {
		return function(input, min, max) {
			min = parseInt(min);
			max = parseInt(max);
			for (var i = min; i <= max; i++) {
				input.push(i);
			}
			return input;
		};
	})
	.config(['$httpProvider', function ($httpProvider) {
		$httpProvider.defaults.headers.common['Content-Type'] = 'application/x-www-form-urlencoded';
		$httpProvider.defaults.xsrfCookieName = 'csrftoken';
  		$httpProvider.defaults.xsrfHeaderName = 'X-CSRFToken';
	}])
	.controller('forestMonitorCtrl', function ($scope, $sanitize, appSettings, ForestMonitorService) {

		// Setting variables
		$scope.areaIndexSelectors = appSettings.areaIndexSelectors;

		// Earth Engine
		// Global Variables
		var EE_URL = 'https://earthengine.googleapis.com',
			DEFAULT_ZOOM = 5,
			MAX_ZOOM = 25,
			DEFAULT_CENTER = { lng: 102.93, lat: 16.4 },
			AREA_LIMIT = 20000,
			// Map options
			mapOptions = {
				center: DEFAULT_CENTER,
				zoom: DEFAULT_ZOOM,
				maxZoom: MAX_ZOOM,
				mapTypeControlOptions: {
					style: google.maps.MapTypeControlStyle.DROPDOWN_MENU,
					mapTypeIds: ['terrain', 'roadmap', 'hybrid'],
					position: google.maps.ControlPosition.TOP_CENTER
                },
		        fullscreenControl: true,
		        fullscreenControlOptions: {
		        	position: google.maps.ControlPosition.TOP_LEFT
		        },
				zoomControlOptions: {
				  position: google.maps.ControlPosition.RIGHT_BOTTOM
				},
				scaleControl: true,
				streetViewControl: true,
				streetViewControlOptions: {
				  position: google.maps.ControlPosition.TOP_CENTER
				}
			},
			// Map variable
			map = new google.maps.Map(document.getElementById('map'), mapOptions),
			drawnArea = null;

		// $scope variables
		$scope.alertContent = '';
		$scope.overlays = {};
		$scope.shape = {};
		$scope.toolControlClass = 'glyphicon glyphicon-eye-open';
		$scope.showTabContainer = true;
		$scope.showLoader = false;
		// Reporting element
		$scope.showReportNoPolygon = true;
		$scope.showReportTotalArea = false;
		$scope.showReportTreeCanopy = false;
		$scope.showReportForestGain = false;
		$scope.showReportForestLoss = false;

		$('.js-tooltip').tooltip();

		/**
		 * Layer switcher Style
		 */
		 // Toggle minus and plus sign in layer control
		 $('a.layer-control-toggle').click(function () {
			 if ($(this).find('.glyphicon').hasClass('glyphicon-plus')) {
				 $(this).find('.glyphicon').addClass('glyphicon-minus').removeClass('glyphicon-plus');
			 } else {
				 $(this).find('.glyphicon').addClass('glyphicon-plus').removeClass('glyphicon-minus');
			 }
		 });

		/**
		 * Alert
		 */

		$scope.closeAlert = function () {
			$('.custom-alert').addClass('display-none');
			$scope.alertContent = '';
		};

		var showErrorAlert = function (alertContent) {
			$scope.alertContent = alertContent;
			$('.custom-alert').removeClass('display-none').removeClass('alert-info').removeClass('alert-success').addClass('alert-danger');
		};

		var showSuccessAlert = function (alertContent) {
			$scope.alertContent = alertContent;
			$('.custom-alert').removeClass('display-none').removeClass('alert-info').removeClass('alert-danger').addClass('alert-success');
		};

		var showInfoAlert = function (alertContent) {
			$scope.alertContent = alertContent;
			$('.custom-alert').removeClass('display-none').removeClass('alert-success').removeClass('alert-danger').addClass('alert-info');
		};

		/**
		 * Utilities function
		 **/

		var removeShownGeoJson = function () {
			if ($scope.shownGeoJson) {
				//map.data.remove($scope.shownGeoJson);
				map.data.forEach(function(feature) {
    				map.data.remove(feature);
				});
			}
		};

		var clearSelectedArea = function () {
			$scope.areaSelectFrom = '';
			$scope.areaIndexSelector = '';
			$scope.areaName = '';
			$scope.$apply();
		};

		var clearLayers = function (name) {

			map.overlayMapTypes.forEach (function (layer, index) {
				if (layer.name === name) {
					map.overlayMapTypes.removeAt(index);
				}
			});
		};

		var clearDrawing = function () {

			if ($scope.overlays.polygon) {
				$scope.overlays.polygon.setMap(null);
				$scope.showPolygonDrawing = false;
			}
		};

		/* Updates the image based on the current control panel config. */
		var loadMap = function (mapId, mapToken, type) {

			if (typeof(type) === 'undefined') type = 'map';

			var eeMapOptions = {
				getTileUrl: function (tile, zoom) {
					var url = EE_URL + '/map/';
						url += [mapId, zoom, tile.x, tile.y].join('/');
						url += '?token=' + mapToken;
						return url;
				},
				tileSize: new google.maps.Size(256, 256),
				opacity: 1.0,
				name: type
			};
			var mapType = new google.maps.ImageMapType(eeMapOptions);
			map.overlayMapTypes.push(mapType);
			$scope.overlays[type] = mapType;
		};

		/**
		* Process each point in a Geometry, regardless of how deep the points may lie.
		* @param {google.maps.Data.Geometry} geometry The structure to process
		* @param {function(google.maps.LatLng)} callback A function to call on each
		*     LatLng point encountered (e.g. Array.push)
		* @param {Object} thisArg The value of 'this' as provided to 'callback' (e.g.
		*     myArray)
		*/
		var processPoints = function (geometry, callback, thisArg) {
			if (geometry instanceof google.maps.LatLng) {
				callback.call(thisArg, geometry);
			} else if (geometry instanceof google.maps.Data.Point) {
				callback.call(thisArg, geometry.get());
			} else {
				geometry.getArray().forEach(function(g) {
					processPoints(g, callback, thisArg);
				});
			}
		};

		var getRectangleArray = function (bounds) {
			var start = bounds.getNorthEast();
			var end = bounds.getSouthWest();
			return [start.lng().toFixed(2), start.lat().toFixed(2), end.lng().toFixed(2), end.lat().toFixed(2)];
		};

		var getPolygonArray = function (pathArray) {
			var geom = [];
			for (var i = 0; i < pathArray.length; i++) {
				var coordinatePair = [pathArray[i].lng().toFixed(2), pathArray[i].lat().toFixed(2)];
				geom.push(coordinatePair);
			}
			return geom;
		};

		var computeRectangleArea = function (bounds) {
			if (!bounds) {
				return 0;
			}

			var sw = bounds.getSouthWest();
			var ne = bounds.getNorthEast();
			var southWest = new google.maps.LatLng(sw.lat(), sw.lng());
			var northEast = new google.maps.LatLng(ne.lat(), ne.lng());
			var southEast = new google.maps.LatLng(sw.lat(), ne.lng());
			var northWest = new google.maps.LatLng(ne.lat(), sw.lng());
			return google.maps.geometry.spherical.computeArea([northEast, northWest, southWest, southEast]) / 1e6;
		};

		var verifyBeforeDownload = function (startYear, endYear, requireBoth, checkPolygon) {

			if (typeof(checkPolygon) === 'undefined') checkPolygon = true;
			if (checkPolygon) {
				if (['polygon', 'circle', 'rectangle'].indexOf($scope.shape.type) > -1) {
					if (drawnArea > AREA_LIMIT) {
						showErrorAlert('The drawn polygon is larger than ' + AREA_LIMIT + ' km2. This exceeds the current limitations for downloading data. Please draw a smaller polygon!');
						return false;
					}
				} else {
					showErrorAlert('Please draw a polygon before proceding to download!');
					return false;
				}
			}

			if (typeof(requireBoth) === 'undefined') requireBoth = false;
			if (requireBoth) {
				if (startYear && !endYear) {
					showErrorAlert('Please provide the end year!');
					return false;
				} else if (!startYear && endYear) {
					showErrorAlert('Please provide start year!');
					return false;
				} else if (!(startYear && endYear)) {
					showErrorAlert('Please select both start and end date!');
					return false;
				} else if (Number(startYear) >= Number(endYear)) {
					showErrorAlert('End year must be greater than start year!');
					return false;
				}
			}
			return true;
		};

		$scope.copyToClipBoard = function (type) {
			// Function taken from https://codepen.io/nathanlong/pen/ZpAmjv?editors=0010
			var btnCopy = $('.' + type + 'CpyBtn');
			var copyTest = document.queryCommandSupported('copy');
			var elOriginalText = btnCopy.attr('data-original-title');

			if (copyTest) {
				var copyTextArea = document.createElement('textarea');
				copyTextArea.value = $scope[type + 'DownloadURL'];
				document.body.appendChild(copyTextArea);
				copyTextArea.select();
		    	try {
		    		var successful = document.execCommand('copy');
		    		var msg = successful ? 'Copied!' : 'Whoops, not copied!';
		    		btnCopy.attr('data-original-title', msg).tooltip('show');
		    	} catch (err) {
		    		console.log('Oops, unable to copy');
		    	}
		    	document.body.removeChild(copyTextArea);
		    	btnCopy.attr('data-original-title', elOriginalText);
		  	} else {
		    	// Fallback if browser doesn't support .execCommand('copy')
		    	window.prompt('Copy to clipboard: Ctrl+C or Command+C');
		  	}
		};

		String.prototype.capitalize = function () {
		  return this.replace(/(^|\s)([a-z])/g, function (m, p1, p2) {
		    return p1 + p2.toUpperCase();
		  });
		};

		$scope.getDownloadURL = function (type, startYear, endYear, requireBoth) {
			var verified = verifyBeforeDownload(startYear, endYear, requireBoth);
			if (verified) {
				showInfoAlert('Preparing Download Link...');
				ForestMonitorService.getDownloadURL(type,
													$scope.shape,
													$scope.areaSelectFrom,
													$scope.areaName,
													startYear,
													endYear,
													$scope.treeCanopyDefinition,
													$scope.treeHeightDefinition)
			    .then(function (data) {
					showSuccessAlert('Your Download Link is ready!');
			    	$scope[type + 'DownloadURL'] = data.downloadUrl;
			    	$scope['show' + type.capitalize() + 'DownloadURL'] = true;
			    }, function (error) {
			    	showErrorAlert(error.message);
			        console.log(error);
			    });
			}
		};

		$scope.showGDriveFileName = function (type, startYear, endYear, requireBoth) {
			var verified = verifyBeforeDownload(startYear, endYear, requireBoth);
			if (verified) {
				$scope['show' + type.capitalize() + 'GDriveFileName'] = true;
			}
		};

		$scope.hideGDriveFileName = function (type) {
			$scope['show' + type.capitalize() + 'GDriveFileName'] = false;
		};

		$scope.saveToDrive = function (type, startYear, endYear, requireBoth) {
			var verified = verifyBeforeDownload(startYear, endYear, requireBoth);
			if (verified) {
				// Check if filename is provided, if not use the default one
				var fileName =  $sanitize($('#' + type + 'GDriveFileName').val() || '');
				showInfoAlert('Please wait while I prepare the download link for you. This might take a while!');
				ForestMonitorService.saveToDrive(type,
												 $scope.shape,
												 $scope.areaSelectFrom,
												 $scope.areaName,
												 startYear,
												 endYear,
												 fileName,
												 $scope.treeCanopyDefinition,
												 $scope.treeHeightDefinition)
			    .then(function (data) {
			    	if (data.error) {
				    	showErrorAlert(data.error);
				        console.log(data.error);
			    	} else {
						showInfoAlert(data.info);
				    	$scope.hideGDriveFileName(type);
				    	$('#' + type + 'GDriveFileName').val('');
			    	}
			    }, function (error) {
			    	showErrorAlert(error);
			        console.log(error);
			    });
			}
		};

		/*
		 * Select Options for Variables
		 **/

		$scope.showAreaVariableSelector = false;
		$scope.areaSelectFrom = null;
		$scope.areaName = null;
		$scope.shownGeoJson = null;

		$scope.populateAreaVariableOptions = function (option) {

			$scope.showAreaVariableSelector = true;
			$scope.areaSelectFrom = option.value;
			if ($scope.areaSelectFrom === 'country') {
				$scope.areaVariableOptions = appSettings.countries;
			} else if ($scope.areaSelectFrom === 'province') {
				$scope.areaVariableOptions = appSettings.provinces;
			}
		};

		$scope.loadAreaFromFile = function (name) {

			removeShownGeoJson();
			clearDrawing();

			if (name) {
				$scope.areaName = name;

		        map.data.loadGeoJson(
		            '/static/data/' + $scope.areaSelectFrom + '/' + name + '.json'
		        );

		        map.data.setStyle({
		          fillColor: 'red',
		          strokeWeight: 2,
		          clickable: false
		        });

			} else {
				$scope.areaName = null;
				$scope.shownGeoJson = null;
			}
		};

		/**
		* Tab
		*/
		$('.btn-pref .btn').click (function () {
    		$('.btn-pref .btn').removeClass('btn-primary').addClass('btn-default');
    		// $(".tab").addClass("active"); // instead of this do the below
    		$(this).removeClass('btn-default').addClass('btn-primary');
		});

		$('.btn-pref-inner .btn').click (function () {
    		$('.btn-pref-inner .btn').removeClass('btn-primary').addClass('btn-default');
    		$(this).removeClass('btn-default').addClass('btn-primary');
		});

		/**
		 * Drawing Tool Manager
		 **/

		var drawingManager = new google.maps.drawing.DrawingManager();

		var stopDrawing = function () {
			drawingManager.setDrawingMode(null);
		};

		var getDrawingManagerOptions = function (type) {
		    var typeOptions;

			if (type === 'rectangle') {
				typeOptions = 'rectangleOptions';
			} else if (type === 'circle') {
				typeOptions = 'circleOptions';
			} else if (type === 'polygon') {
				typeOptions = 'polygonOptions';
			}

		    var drawingManagerOptions = {
		    		'drawingControl': false
		    };
		    drawingManagerOptions.drawingMode = type;
		    drawingManagerOptions[typeOptions] = {
	    		'strokeColor': '#ff0000',
				'strokeWeight': 5,
				'fillColor': 'yellow',
				'fillOpacity': 0,
				'editable': true
		    };

			return drawingManagerOptions;

		};

		$scope.drawShape = function (type) {

			drawingManager.setOptions(getDrawingManagerOptions(type));
			// Loading the drawing Tool in the Map.
			drawingManager.setMap(map);

		};

		var updateReportTotalArea = function () {
			// Reporting Element
			$scope.showReportNoPolygon = false;
			$scope.reportTotalAreaValue = (Math.round(drawnArea * 100 * 100) / 100).toLocaleString() + ' ha';
			$scope.showReportTotalArea = true;
			$scope.$apply();
		};

		// Listeners
		// Overlay Listener
		google.maps.event.addListener(drawingManager, 'overlaycomplete', function (event) {
			// Clear Layer First
			clearDrawing();
			var overlay = event.overlay;
			$scope.overlays.polygon = overlay;
			$scope.shape = {};

			var drawingType = event.type;
			$scope.shape.type = drawingType;
			if (drawingType === 'rectangle') {
				$scope.shape.geom = getRectangleArray(overlay.getBounds());
				drawnArea = computeRectangleArea(overlay.getBounds());
				// Change event
				google.maps.event.addListener(overlay, 'bounds_changed', function () {
					$scope.shape.geom = getRectangleArray(event.overlay.getBounds());
					drawnArea = computeRectangleArea(event.overlay.getBounds());
					updateReportTotalArea();
				});
			} else if (drawingType === 'circle') {
				$scope.shape.center = [overlay.getCenter().lng().toFixed(2), overlay.getCenter().lat().toFixed(2)];
				$scope.shape.radius = overlay.getRadius().toFixed(2); // unit: meter
				drawnArea = Math.PI * Math.pow(overlay.getRadius()/1000, 2);
				// Change event
				google.maps.event.addListener(overlay, 'radius_changed', function () {
					$scope.shape.radius = event.overlay.getRadius().toFixed(2);
					drawnArea = Math.PI * Math.pow(event.overlay.getRadius()/1000, 2);
					updateReportTotalArea();
				});
				google.maps.event.addListener(overlay, 'center_changed', function () {
					$scope.shape.center = [event.overlay.getCenter().lng().toFixed(2), event.overlay.getCenter().lat().toFixed(2)];
					drawnArea = Math.PI * Math.pow(event.overlay.getRadius()/1000, 2);
					updateReportTotalArea();
				});
			} else if (drawingType === 'polygon') {
				var path = overlay.getPath();
				$scope.shape.geom = getPolygonArray(path.getArray());
				drawnArea = google.maps.geometry.spherical.computeArea(path) / 1e6;
				// Change event
				google.maps.event.addListener(path, 'insert_at', function () {
					$scope.shape.geom = getPolygonArray(event.overlay.getPath().getArray());
					drawnArea = google.maps.geometry.spherical.computeArea(event.overlay.getPath()) / 1e6;
					updateReportTotalArea();
				});
				google.maps.event.addListener(path, 'remove_at', function () {
					$scope.shape.geom = getPolygonArray(event.overlay.getPath().getArray());
					drawnArea = google.maps.geometry.spherical.computeArea(event.overlay.getPath()) / 1e6;
					updateReportTotalArea();
				});
				google.maps.event.addListener(path, 'set_at', function () {
					$scope.shape.geom = getPolygonArray(event.overlay.getPath().getArray());
					drawnArea = google.maps.geometry.spherical.computeArea(event.overlay.getPath()) / 1e6;
					updateReportTotalArea();
				});
			}

			stopDrawing();
			clearSelectedArea();
			removeShownGeoJson();
			updateReportTotalArea();
		});

		// Geojson listener
        map.data.addListener('addfeature', function (event) {
        	$scope.shownGeoJson = event.feature;
        	var bounds = new google.maps.LatLngBounds();
        	var _geometry = event.feature.getGeometry();
        	processPoints(_geometry, bounds.extend, bounds);
        	map.fitBounds(bounds);
        	drawnArea = google.maps.geometry.spherical.computeArea(_geometry.getArray()[0].b) / 1e6;
        	updateReportTotalArea();
        });

        map.data.addListener('removefeature', function (event) {
        	$scope.shownGeoJson = null;
        });

		/**
		 * Upload Area Button
		 **/
		var readFile = function () {

			var files = event.target.files;
			if (files.length > 1) {
				showErrorAlert('upload one file at a time');
				$scope.$apply();
			} else {
				removeShownGeoJson();

				var file = files[0];
				var reader = new FileReader();
				reader.readAsText(file);

				reader.onload = function () {

					var textResult = event.target.result;
					var addedGeoJson;

					if ((['application/vnd.google-earth.kml+xml', 'application/vnd.google-earth.kmz'].indexOf(file.type) > -1) ) {

						var kmlDoc;

    					if (window.DOMParser) {
        					var parser = new DOMParser();
        					kmlDoc = parser.parseFromString(textResult, 'text/xml');
    					} else { // Internet Explorer
        					kmlDoc = new ActiveXObject('Microsoft.XMLDOM');
        					kmlDoc.async = false;
        					kmlDoc.loadXML(textResult);
    					}
    					addedGeoJson = toGeoJSON.kml(kmlDoc);
					} else {
						try {
							addedGeoJson = JSON.parse(textResult);
						} catch (e) {
							showErrorAlert('we only accept kml, kmz and geojson');
							$scope.$apply();
						}
					}

					if (((addedGeoJson.features) && (addedGeoJson.features.length === 1)) || (addedGeoJson.type === 'Feature')) {

						var geometry = addedGeoJson.features ? addedGeoJson.features[0].geometry: addedGeoJson.geometry;

						if (geometry.type === 'Polygon') {

					        map.data.addGeoJson(addedGeoJson);
					        map.data.setStyle({
					        	fillColor: 'red',
					          	strokeWeight: 2,
					          	clickable: false
					        });

					        // Convert to Polygon
							var polygonArray = [];
							var _coord = geometry.coordinates[0];

        					for (var i = 0; i < _coord.length; i++) {
        						var coordinatePair = [(_coord[i][0]).toFixed(2), (_coord[i][1]).toFixed(2)];
            					polygonArray.push(coordinatePair);
       						}

       						if (polygonArray.length > 500) {
       							showInfoAlert('Complex geometry will be simplified using the convex hull algorithm!');
       							$scope.$apply();
       						}

       						clearSelectedArea();
       						$scope.shape.type = 'polygon';
       						$scope.shape.geom = polygonArray;
						} else {
							showErrorAlert('multigeometry and multipolygon not supported yet!');
							$scope.$apply();
						}
					} else {
						showErrorAlert('multigeometry and multipolygon not supported yet!');
						$scope.$apply();
					}
				};
			}
		};

		$('#file-input-container #file-input').change( function () {
			$scope.showLoader = true;
			$scope.$apply();
			clearDrawing();
			readFile();
			$(this).remove();
    		$("<input type='file' class='hide' id='file-input' accept='.kml,.kmz,.json,.geojson,application/json,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz'>").change(readFile).appendTo($('#file-input-container'));
    		$scope.showLoader = false;
		});

		/**
		 * Custom Control
		 */

		// Analysis Tool Control
		$scope.toggleToolControl = function () {

			if ($('#analysis-tool-control span').hasClass('glyphicon-eye-open')) {
				$('#analysis-tool-control span').removeClass('glyphicon glyphicon-eye-open large-icon').addClass('glyphicon glyphicon-eye-close large-icon');
				$scope.showTabContainer = false;
			} else {
				$('#analysis-tool-control span').removeClass('glyphicon glyphicon-eye-close large-icon').addClass('glyphicon glyphicon-eye-open large-icon');
				$scope.showTabContainer = true;
			}
			$scope.$apply();
		};

		function AnalysisToolControl(controlDiv, map) {

			// Set CSS for the control border.
			var controlUI = document.createElement('div');
			controlUI.setAttribute('class', 'tool-control text-center');
			controlUI.setAttribute('id', 'analysis-tool-control');
			controlUI.title = 'Toogle Tools Visibility';
			controlUI.innerHTML = "<span class='glyphicon glyphicon-eye-open large-icon' aria-hidden='true'></span>";
			controlDiv.appendChild(controlUI);

			// Setup the click event listeners
			controlUI.addEventListener('click', function() {
			  	$scope.toggleToolControl();
			});
		}

		var analysisToolControlDiv = document.getElementById('tool-control-container');
		var analysisToolControl = new AnalysisToolControl(analysisToolControlDiv, map);
		map.controls[google.maps.ControlPosition.TOP_RIGHT].push(analysisToolControlDiv);

		// KML Upload Tool Control
		/*
		var KMLUploadToolControl = function (controlDiv, map) {

			// Set CSS for the control border.
			var controlUI = document.createElement('div');
			controlUI.setAttribute('class', 'tool-control text-center');
			controlUI.title = 'Toogle Tools Visibility';
			controlUI.innerHTML = "<label for='file-input'><span class='glyphicon glyphicon-upload large-icon' type='file' aria-hidden='true'></span></label><input type='file' accept='.kml,.kmz,.json,.geojson,application/json,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz' class='hide form-control' name='file-input' id='file-input'>";
			controlDiv.appendChild(controlUI);

			// Setup the click event listeners
			controlUI.addEventListener('click', function() {
				$('#file-input').change( function () {
					readFile();
				});
			});
		};

		var kmlUploadToolControlDiv = document.createElement('div');
		var kmlUploadToolControl = new KMLUploadToolControl(kmlUploadToolControlDiv, map);
		map.controls[google.maps.ControlPosition.TOP_RIGHT].push(kmlUploadToolControlDiv);
		*/

		var datepickerOptions = {
			autoclose: true,
			clearBtn: true,
			container: '.datepicker'
		};

		$('#time-period-tab>#datepicker').datepicker(datepickerOptions);

		/**
		 * Slider
		 */
		var sliderOptions = {
			formatter: function (value) {
				return 'Opacity: ' + value;
			}
		};

		/*
		 * Tree Canopy Calculations
		 */
		$scope.showTreeCanopyOpacitySlider = false;
		$scope.treeCanopyOpacitySliderValue = null;
		$scope.showTreeCanopyDownloadButtons = false;
		$scope.showTreeCanopyDownloadURL = false;
		$scope.showTreeCanopyGDriveFileName = false;
		$scope.treeCanopyDownloadURL = '';

		/* slider init */
		var treeCanopySlider = $('#tree-canopy-opacity-slider').slider(sliderOptions)
		.on('slideStart', function (event) {
			$scope.treeCanopyOpacitySliderValue = $(this).data('slider').getValue();
		})
		.on('slideStop', function (event) {
		    var value = $(this).data('slider').getValue();
		    if (value !== $scope.treeCanopyOpacitySliderValue) {
				$scope.treeCanopyOpacitySliderValue = value;
		    	$scope.overlays.treeCanopy.setOpacity(value);
		    }
		});

		/* Layer switcher */
		$('#treeCanopySwitch').change(function () {
			if ($(this).is(':checked')) {
				$scope.overlays.treeCanopy.setOpacity($scope.treeCanopyOpacitySliderValue);
			} else {
				$scope.overlays.treeCanopy.setOpacity(0);
			}
		});

		$scope.treeCanopyYearChange = function (year) {

			$scope.showLoader = true;
			var name = 'treeCanopy';
			clearLayers(name);
			$scope.closeAlert();
			// Close and restart this after success
			$scope.showTreeCanopyOpacitySlider = false;

			ForestMonitorService.treeCanopyChange(
				year,
				$scope.shape,
				$scope.areaSelectFrom,
				$scope.areaName,
				$scope.showReportNoPolygon ? false : true,
				$scope.treeCanopyDefinition
			)
		    .then(function (data) {
		    	removeShownGeoJson();
		    	loadMap(data.eeMapId, data.eeMapToken, name);
		    	treeCanopySlider.slider('setValue', 1);
		    	$scope.showTreeCanopyOpacitySlider = true;
		    	$scope.showTreeCanopyDownloadButtons = true;
		    	// Reporting Element
		    	if (!$scope.showReportNoPolygon) {
		    		if (data.reportArea) {
			    		$scope.reportTreeCanopyTitle = 'Tree Canopy Cover for ' + year;
			    		$scope.reportTreeCanopyValue = data.reportArea + ' ha';
			    		$scope.showReportTreeCanopy = true;
		    		} else if (data.reportError) {
		    			$scope.reportTreeCanopyTitle = 'Error calculating Canopy';
		    			$scope.reportTreeCanopyValue = data.reportError;
		    			$scope.showReportTreeCanopy = true;
		    		}
		    	}
		    	showSuccessAlert('Tree Canopy Cover for year ' + year + ' !');
		    	$scope.showLoader = false;
		    }, function (error) {
		    	$scope.showLoader = false;
		        console.log(error);
		        showErrorAlert(error);
		    });
		};

		/*
		 * Tree Height Calculations
		 */
		$scope.showTreeHeightOpacitySlider = false;
		$scope.treeHeightOpacitySliderValue = null;
		$scope.showTreeHeightDownloadButtons = false;
		$scope.showTreeHeightDownloadURL = false;
		$scope.showTreeHeightGDriveFileName = false;
		$scope.treeHeightDownloadURL = '';

		/* slider init */
		var treeHeightSlider = $('#tree-height-opacity-slider').slider(sliderOptions)
		.on('slideStart', function (event) {
			$scope.treeHeightOpacitySliderValue = $(this).data('slider').getValue();
		})
		.on('slideStop', function (event) {
		    var value = $(this).data('slider').getValue();
		    if (value !== $scope.treeHeightOpacitySliderValue) {
				$scope.treeHeightOpacitySliderValue = value;
		    	$scope.overlays.treeHeight.setOpacity(value);
		    }
		});

		/* Layer switcher */
		$('#treeHeightSwitch').change(function () {
			if ($(this).is(":checked")) {
				$scope.overlays.treeHeight.setOpacity($scope.treeHeightOpacitySliderValue);
			} else {
				$scope.overlays.treeHeight.setOpacity(0);
			}
		});

		$scope.treeHeightYearChange = function(year) {

			$scope.showLoader = true;
			var name = 'treeHeight';
			clearLayers(name);
			$scope.closeAlert();
			$scope.showTreeHeightOpacitySlider = false;

			ForestMonitorService.treeHeightChange(
				year,
				$scope.shape,
				$scope.areaSelectFrom,
				$scope.areaName,
				$scope.treeHeightDefinition
			)
		    .then(function (data) {
		    	removeShownGeoJson();
		    	loadMap(data.eeMapId, data.eeMapToken, name);
		    	treeHeightSlider.slider('setValue', 1);
		    	$scope.showTreeHeightOpacitySlider = true;
		    	showSuccessAlert('Tree Canopy Height for year ' + year + ' !');
		    	$scope.showTreeHeightDownloadButtons = true;
		    	$scope.showLoader = false;
		    }, function (error) {
		    	$scope.showLoader = false;
		        console.log(error);
		        showErrorAlert(error);
		    });
		};

		/*
		 * Forest Gain Calculations
		 */
		$scope.showForestGainOpacitySlider = false;
		$scope.forestGainOpacitySliderValue = null;
		$scope.showForestGainDownloadButtons = false;
		$scope.showForestGainDownloadURL = false;
		$scope.showForestGainGDriveFileName = false;
		$scope.forestGainDownloadURL = '';

		/* slider init */
		var forestGainSlider = $('#forest-gain-opacity-slider').slider(sliderOptions)
		.on('slideStart', function (event) {
			$scope.forestGainOpacitySliderValue = $(this).data('slider').getValue();
		})
		.on('slideStop', function (event) {
		    var value = $(this).data('slider').getValue();
		    if (value !== $scope.forestGainOpacitySliderValue) {
				$scope.forestGainOpacitySliderValue = value;
		    	$scope.overlays.forestGain.setOpacity(value);
		    }
		});

		/* Layer switcher */
		$('#forestGainSwitch').change(function () {
			if ($(this).is(":checked")) {
				$scope.overlays.forestGain.setOpacity($scope.forestGainOpacitySliderValue);
			} else {
				$scope.overlays.forestGain.setOpacity(0);
			}
		});

		$scope.calculateForestGain = function (startYear, endYear) {

			if ( verifyBeforeDownload(startYear, endYear, true, false) ) {

				$scope.showLoader = true;
				var name = 'forestGain';
				clearLayers(name);
				$scope.closeAlert();
				$scope.showForestGainOpacitySlider = false;

				ForestMonitorService.forestGain(startYear,
												endYear,
												$scope.shape,
												$scope.areaSelectFrom,
												$scope.areaName,
												$scope.treeCanopyDefinition,
												$scope.treeHeightDefinition,
												$scope.showReportNoPolygon ? false : true)
			    .then(function (data) {
			    	removeShownGeoJson();
			    	loadMap(data.eeMapId, data.eeMapToken, name);
			    	forestGainSlider.slider('setValue', 1);
			    	$scope.showForestGainOpacitySlider = true;
			    	$scope.showForestGainDownloadButtons = true;
			    	// Reporting Element
			    	if (!$scope.showReportNoPolygon) {
			    		if (data.reportArea) {
				    		$scope.reportForestGainTitle = 'GAIN (' + startYear + ' - ' + endYear + ') with >' + $scope.treeCanopyDefinition + '% canopy density and >' + $scope.treeHeightDefinition + ' meters';
				    		$scope.reportForestGainValue = data.reportArea + ' ha';
				    		$scope.showReportForestGain = true;
			    		} else if (data.reportError) {
			    			$scope.reportForestGainTitle = 'Error calculating Forest Gain';
			    			$scope.reportForestGainValue = data.reportError;
			    			$scope.showReportForestGain = true;
			    		}
			    	}
			    	showSuccessAlert('Forest Gain from year ' + startYear + ' to ' + endYear + ' !');
			    	$scope.showLoader = false;
			    }, function (error) {
			    	$scope.showLoader = false;
			        console.log(error);
			        showErrorAlert(error);
			    });
			}
		};

		/*
		 * Forest Loss Calculations
		 */
		$scope.showForestLossOpacitySlider = false;
		$scope.forestLossOpacitySliderValue = null;
		$scope.showForestLossDownloadButtons = false;
		$scope.showForestLossDownloadURL = false;
		$scope.showForestLossGDriveFileName = false;
		$scope.forestLossDownloadURL = '';

		/* slider init */
		var forestLossSlider = $('#forest-loss-opacity-slider').slider(sliderOptions)
		.on('slideStart', function (event) {
			$scope.forestLossOpacitySliderValue = $(this).data('slider').getValue();
		})
		.on('slideStop', function (event) {
		    var value = $(this).data('slider').getValue();
		    if (value !== $scope.forestLossOpacitySliderValue) {
				$scope.forestLossOpacitySliderValue = value;
		    	$scope.overlays.forestLoss.setOpacity(value);
		    }
		});

		/* Layer switcher */
		$('#forestLossSwitch').change(function () {
			if ($(this).is(":checked")) {
				$scope.overlays.forestLoss.setOpacity($scope.forestLossOpacitySliderValue);
			} else {
				$scope.overlays.forestLoss.setOpacity(0);
			}
		});

		$scope.calculateForestLoss = function (startYear, endYear) {

			if ( verifyBeforeDownload(startYear, endYear, true, false) ) {
				$scope.showLoader = true;
				var name = 'forestLoss';
				clearLayers(name);
				$scope.closeAlert();
				$scope.showForestLossOpacitySlider = false;

				ForestMonitorService.forestLoss(startYear,
												endYear,
												$scope.shape,
												$scope.areaSelectFrom,
												$scope.areaName,
												$scope.treeCanopyDefinition,
												$scope.treeHeightDefinition,
												$scope.showReportNoPolygon ? false : true)
			    .then(function (data) {
			    	removeShownGeoJson();
			    	loadMap(data.eeMapId, data.eeMapToken, name);
			    	forestLossSlider.slider('setValue', 1);
			    	$scope.showForestLossOpacitySlider = true;
			    	$scope.showForestLossDownloadButtons = true;
			    	// Reporting Element
			    	if (!$scope.showReportNoPolygon) {
			    		if (data.reportArea) {
				    		$scope.reportForestLossTitle = 'LOSS (' + startYear + ' - ' + endYear + ') with >' + $scope.treeCanopyDefinition + '% canopy density and >' + $scope.treeHeightDefinition + ' meters';
				    		$scope.reportForestLossValue = data.reportArea + ' ha';
				    		$scope.showReportForestLoss = true;
			    		} else if (data.reportError) {
			    			$scope.reportForestLossTitle = 'Error calculating Forest Loss';
			    			$scope.reportForestLossValue = data.reportError;
			    			$scope.showReportForestLoss = true;
			    		}
			    	}
			    	showSuccessAlert('Forest Loss from year ' + startYear + ' to ' + endYear + ' !');
			    	$scope.showLoader = false;
			    }, function (error) {
			    	$scope.showLoader = false;
			        console.log(error);
			        showErrorAlert(error);
			    });
			}
		};

		/*
		 * Forest Change Calculations
		 */
		$scope.showForestChangeOpacitySlider = false;
		$scope.forestChangeOpacitySliderValue = null;
		$scope.showForestChangeDownloadButtons = false;
		$scope.showForestChangeDownloadURL = false;
		$scope.showForestChangeGDriveFileName = false;
		$scope.forestChangeDownloadURL = '';

		/* slider init */
		var forestChangeSlider = $('#forest-change-opacity-slider').slider(sliderOptions)
		.on('slideStart', function (event) {
			$scope.forestChangeOpacitySliderValue = $(this).data('slider').getValue();
		})
		.on('slideStop', function (event) {
		    var value = $(this).data('slider').getValue();
		    if (value !== $scope.forestChangeOpacitySliderValue) {
				$scope.forestChangeOpacitySliderValue = value;
		    	$scope.overlays.forestChange.setOpacity(value);
		    }
		});

		/* Layer switcher */
		$('#forestChangeSwitch').change(function () {
			if ($(this).is(":checked")) {
				$scope.overlays.forestChange.setOpacity($scope.forestChangeOpacitySliderValue);
			} else {
				$scope.overlays.forestChange.setOpacity(0);
			}
		});

		$scope.calculateForestChange = function (startYear, endYear) {

			if ( verifyBeforeDownload(startYear, endYear, true, false) ) {

				$scope.showLoader = true;
				var name = 'forestChange';
				clearLayers(name);
				$scope.closeAlert();
				$scope.showForestChangeOpacitySlider = false;

				ForestMonitorService.forestChange(startYear,
												  endYear,
												  $scope.shape,
												  $scope.areaSelectFrom,
												  $scope.areaName,
												  $scope.treeCanopyDefinition,
												  $scope.treeHeightDefinition)
			    .then(function (data) {
			    	removeShownGeoJson();
			    	loadMap(data.eeMapId, data.eeMapToken, name);
			    	forestChangeSlider.slider('setValue', 1);
			    	$scope.showForestChangeOpacitySlider = true;
			    	$scope.showForestChangeDownloadButtons = true;
			    	showSuccessAlert('Forest Change from year ' + startYear + ' to ' + endYear + ' !');
			    	$scope.showLoader = false;
			    }, function (error) {
			    	$scope.showLoader = false;
			        console.log(error);
			        showErrorAlert(error);
			    });
			}
		};

	});

})();
