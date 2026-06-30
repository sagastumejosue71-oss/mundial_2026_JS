<?php

use Illuminate\Support\Facades\Route;

Route::get('/', function () {
    $path = base_path('../index.php');

    return response()->file($path, ['Content-Type' => 'text/html; charset=UTF-8']);
});
