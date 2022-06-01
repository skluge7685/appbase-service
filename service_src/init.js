module.exports.init = async function(logger) {

    return new Promise((resolve, reject) => {

        var ret_value = {};
        logger.log('info', 'in progress ....', {tags: 'CUSTOM INIT', additionalInfo: {}});

        ///////////////////////////////////////////////////////////////////
        //Start HERE with Costumize Initalisation

        

        //Finish initialization
        resolve(ret_value);
    })
}